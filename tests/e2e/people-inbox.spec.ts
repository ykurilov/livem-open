import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots, outboundMessages } from "../../src/modules/channels/schema";
import { inboundMessages, passages } from "../../src/modules/conversations/schema";
import { createLeadMagnet, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
import { createField, rememberAboutPerson } from "../../src/modules/people";
import { people } from "../../src/modules/people/schema";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv, FRESH_CONNECTION } from "./e2e-env";

let connection: DatabaseConnection;

test.beforeAll(() => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
});

test.afterAll(async () => {
  await connection.close();
});

test.beforeEach(async ({ context }) => {
  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
});

test("эксперт находит человека фильтром, открывает карточку и отвечает ему во «Входящих»", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { db } = connection;
  const tag = Date.now().toString(36);

  // Свои бот, лидмагнит и поле — сразу в базе: подключение бота и публикацию проверяет другой сценарий
  const token = `fake-people${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот базы ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_people${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  const leadName = `База ${tag}`;
  const lead = await createLeadMagnet(db, { name: leadName });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
  const { code } = await publishWithBots(db, lead.id, { telegram: bot!.id });
  const fieldName = `Есть свой курс ${tag}`;
  const hasCourse = await createField(db, { name: fieldName, type: "boolean", description: "" });

  let update = 0;
  const say = async (userId: string, userName: string, text: string, startCode?: string) => {
    const response = await request.post(`/api/webhooks/telegram/${bot!.id}`, {
      headers: { ...FRESH_CONNECTION, "x-fake-secret": bot!.webhookSecret },
      data: { events: [{ type: "message", dedupeKey: `people:${tag}:${++update}`, userId, userName, text, ...(startCode && { startCode }) }] },
    });
    expect(response.status()).toBe(200);
  };
  const personOf = async (userId: string) =>
    (await db.select().from(people).where(and(eq(people.botId, bot!.id), eq(people.externalUserId, userId))))[0];
  const lastSent = async (userId: string) => {
    const person = await personOf(userId);
    if (!person) return undefined;
    const rows = await db
      .select()
      .from(outboundMessages)
      .where(and(eq(outboundMessages.personId, person.id), eq(outboundMessages.status, "sent")))
      .orderBy(outboundMessages.createdAt);
    return rows.at(-1)?.text;
  };

  // Аня проходит лидмагнит до конца, Боря только начал
  const anya = `Аня ${tag}`;
  await say("anya", anya, `/start ${code}`, code);
  await expect.poll(() => lastSent("anya"), { timeout: 30_000 }).toContain(E2E_SCRIPT.firstMessage);
  await say("anya", anya, "Я дизайнер");
  await expect.poll(() => lastSent("anya"), { timeout: 30_000 }).toBe(E2E_SCRIPT.consultantReply);
  await say("anya", anya, `Я ${E2E_SCRIPT.finishTrigger} к созвону`);
  await expect
    .poll(async () => (await db.select().from(passages).where(eq(passages.personId, (await personOf("anya"))!.id)))[0]?.status, { timeout: 30_000 })
    .toBe("completed");
  await say("borya", `Боря ${tag}`, `/start ${code}`, code);
  await expect.poll(() => lastSent("borya"), { timeout: 30_000 }).toContain(E2E_SCRIPT.firstMessage);
  const anyaRow = await personOf("anya");
  await rememberAboutPerson(db, anyaRow!.id, { facts: [], fieldValues: { [hasCourse.id]: true }, source: "e2e", at: new Date() });

  // База → фильтр по лидмагниту и полю → карточка
  await page.goto("/people");
  await page.getByRole("combobox", { name: "Лидмагнит" }).selectOption({ label: leadName });
  await page.getByRole("button", { name: "Показать" }).click();
  await expect(page.getByTestId("people-count")).toHaveText("Найдено: 2");

  await page.getByRole("button", { name: "Условие по полю" }).click();
  await page.getByRole("combobox", { name: "Поле" }).selectOption({ label: fieldName });
  await page.getByRole("button", { name: "Показать" }).click();
  await expect(page.getByTestId("people-count")).toHaveText("Найдено: 1");

  await page.getByRole("link", { name: anya }).click();
  // Страница человека в `next dev` может собираться впервые
  await expect(page.getByRole("heading", { name: anya })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("person-fields")).toContainText(fieldName);
  await page.getByText("Переписка (").click();
  await expect(page.getByTestId("person-passage")).toContainText("Я дизайнер");

  // После конца лидмагнита сообщение Ани попадает во «Входящие»
  await say("anya", anya, "А когда созвон?");
  await expect
    .poll(async () => (await db.select().from(inboundMessages).where(eq(inboundMessages.personId, anyaRow!.id))).some((row) => row.route === "inbox"), { timeout: 30_000 })
    .toBe(true);

  await page.goto("/inbox");
  await page.getByRole("link", { name: new RegExp(anya) }).click();
  await expect(page.getByTestId("inbox-messages")).toContainText("А когда созвон?");
  await page.getByLabel("Ваш ответ").fill("Завтра в 12:00");
  await page.getByRole("button", { name: "Отправить" }).click();

  await expect.poll(() => lastSent("anya"), { timeout: 30_000 }).toBe("Завтра в 12:00");
  const [reply] = await db
    .select()
    .from(outboundMessages)
    .where(and(eq(outboundMessages.personId, anyaRow!.id), eq(outboundMessages.kind, "manual_reply")));
  expect(reply).toMatchObject({ botId: bot!.id, status: "sent" });
  await expect(page.getByRole("navigation", { name: "Неотвеченные" }).getByRole("link", { name: new RegExp(anya) })).toHaveCount(0);
});
