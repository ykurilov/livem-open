import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots, outboundMessages } from "../../src/modules/channels/schema";
import { privacyPolicyLine } from "../../src/modules/conversations/router";
import { passages } from "../../src/modules/conversations/schema";
import { createLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { people } from "../../src/modules/people/schema";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { updateSettings } from "../../src/modules/platform/settings";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, FRESH_CONNECTION } from "./e2e-env";

const POLICY_URL = "https://example.com/privacy";
const FAREWELL = "Спасибо за разговор! До встречи.";

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

test("эксперт публикует лидмагнит, человек проходит его в мессенджере до конца и попадает в базу", async ({ page, request }) => {
  // Первая сборка страниц в `next dev` долгая
  test.setTimeout(180_000);
  const { db } = connection;
  const tag = Date.now().toString(36);
  const personId = `person-${tag}`;

  // Бот подключается через экран «Боты» (подделка мессенджера принимает токены `fake-…`)
  await page.goto("/bots");
  await page.getByLabel("Токен бота").fill(`fake-e2e${tag}`);
  await page.getByRole("button", { name: "Подключить" }).click();
  await expect(page.getByText("Бот подключён")).toBeVisible({ timeout: 60_000 });
  const [bot] = await db.select().from(bots).where(eq(bots.username, `bot_e2e${tag}`));
  expect(bot).toBeDefined();

  // Лидмагнит с настройками консультанта — сразу в базе: редактор проверяет свой сценарий
  const lead = await createLeadMagnet(db, { name: `Публикуемый ${tag}` });
  await saveDraft(
    db,
    lead.id,
    { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage, farewellMessage: FAREWELL },
    "manual",
  );
  await updateSettings(db, { privacyPolicyUrl: POLICY_URL });

  await page.goto(`/lead-magnets/${lead.id}/publish`);
  await page.getByRole("combobox", { name: "Бот Telegram" }).selectOption(bot!.id);
  await page.getByRole("button", { name: "Опубликовать" }).click();
  await expect(page.getByText("Опубликовано", { exact: true })).toBeVisible({ timeout: 30_000 });
  const link = await page.getByTestId("entry-link-telegram").textContent();
  const code = /start=([A-Za-z0-9]{8})$/.exec(link ?? "")?.[1];
  expect(code, `ссылка: ${link}`).toBeDefined();
  await expect(page.getByRole("button", { name: "Опубликовать снова" })).toBeVisible();

  let update = 0;
  const say = async (text: string, startCode?: string) => {
    const response = await request.post(`/api/webhooks/telegram/${bot!.id}`, {
      headers: { ...FRESH_CONNECTION, "x-fake-secret": bot!.webhookSecret },
      data: {
        events: [
          { type: "message", dedupeKey: `e2e:${tag}:${++update}`, userId: personId, userName: "Вася", text, ...(startCode && { startCode }) },
        ],
      },
    });
    expect(response.status()).toBe(200);
  };
  const sentTexts = async () => {
    const [person] = await db.select().from(people).where(eq(people.externalUserId, personId));
    if (!person) return [];
    const rows = await db
      .select()
      .from(outboundMessages)
      .where(and(eq(outboundMessages.personId, person.id), eq(outboundMessages.status, "sent")))
      .orderBy(outboundMessages.createdAt);
    return rows.map((row) => row.text);
  };

  // Чужой секрет — отказ
  const forged = await request.post(`/api/webhooks/telegram/${bot!.id}`, {
    headers: { ...FRESH_CONNECTION, "x-fake-secret": "wrong-secret" },
    data: { events: [] },
  });
  expect(forged.status()).toBe(401);

  await say(`/start ${code}`, code);
  await expect.poll(sentTexts, { timeout: 30_000 }).toEqual([`${E2E_SCRIPT.firstMessage}\n\n${privacyPolicyLine(POLICY_URL)}`]);

  await say("Я дизайнер");
  await expect.poll(async () => (await sentTexts()).at(-1), { timeout: 30_000 }).toBe(E2E_SCRIPT.consultantReply);

  await say(`Я ${E2E_SCRIPT.finishTrigger} к созвону`);
  await expect.poll(async () => (await sentTexts()).at(-1), { timeout: 30_000 }).toBe(`${E2E_SCRIPT.finalReply}\n\n${FAREWELL}`);

  const [person] = await db.select().from(people).where(eq(people.externalUserId, personId));
  expect(person).toMatchObject({ botId: bot!.id, displayName: "Вася", channel: "telegram" });
  const [passage] = await db.select().from(passages).where(eq(passages.personId, person!.id));
  expect(passage).toMatchObject({ leadMagnetId: lead.id, status: "completed", personMessageCount: 2 });
  expect(passage!.summary).not.toBeNull();
});
