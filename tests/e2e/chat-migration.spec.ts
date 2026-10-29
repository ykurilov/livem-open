import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots, outboundMessages } from "../../src/modules/channels/schema";
import { passages } from "../../src/modules/conversations/schema";
import { leadMagnetToFlow } from "../../src/modules/flows/settings-to-flow";
import { createLeadMagnet, getLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { people } from "../../src/modules/people/schema";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv, FRESH_CONNECTION } from "./e2e-env";

// Перевод идущих разговоров: версия 1, разговор, версия 2, перевод кнопкой — разговор отвечает по новой версии
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

test("эксперт переводит идущий разговор на новую версию — человек дальше получает ответы по новым правилам", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { db } = connection;
  const tag = Date.now().toString(36);
  const token = `fake-mig${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_mig${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  const lead = await createLeadMagnet(db, { name: `Перевод ${tag}` });
  const v1 = { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage };
  await saveDraft(db, lead.id, { ...v1, flow: leadMagnetToFlow(v1, []) }, "manual");

  // Версия 1
  await page.goto(`/lead-magnets/${lead.id}/publish`);
  await page.getByRole("combobox", { name: "Бот Telegram" }).selectOption(bot!.id);
  await page.getByRole("button", { name: "Опубликовать" }).click();
  await expect(page.getByText("Опубликовано", { exact: true })).toBeVisible({ timeout: 30_000 });
  const link = await page.getByTestId("entry-link-telegram").textContent();
  const code = /start=([A-Za-z0-9]{8})$/.exec(link ?? "")?.[1];
  expect(code, `ссылка: ${link}`).toBeDefined();

  const personId = `person-${tag}`;
  let update = 0;
  const say = async (text: string, startCode?: string) => {
    const response = await request.post(`/api/webhooks/telegram/${bot!.id}`, {
      headers: { ...FRESH_CONNECTION, "x-fake-secret": bot!.webhookSecret },
      data: { events: [{ type: "message", dedupeKey: `mig:${tag}:${++update}`, userId: personId, userName: "Оля", text, ...(startCode && { startCode }) }] },
    });
    expect(response.status()).toBe(200);
  };
  const lastSent = async () => {
    const [person] = await db.select().from(people).where(eq(people.externalUserId, personId));
    if (!person) return undefined;
    const rows = await db
      .select()
      .from(outboundMessages)
      .where(and(eq(outboundMessages.personId, person.id), eq(outboundMessages.status, "sent")))
      .orderBy(outboundMessages.createdAt);
    return rows.at(-1)?.text;
  };

  await say(`/start ${code}`, code);
  await expect.poll(lastSent, { timeout: 30_000 }).toContain(E2E_SCRIPT.firstMessage);
  await say("Я дизайнер");
  await expect.poll(lastSent, { timeout: 30_000 }).toBe(E2E_SCRIPT.consultantReply);

  // Версия 2: новое правило в общей инструкции
  const draft = (await getLeadMagnet(db, lead.id))!.draft;
  await saveDraft(db, lead.id, { ...draft, flow: { ...draft.flow, common: `${draft.flow.common}\n${E2E_SCRIPT.newVersionMark}` } }, "manual");
  await page.reload();
  await page.getByRole("button", { name: "Опубликовать снова" }).click();
  await expect(page.getByText("Опубликовано", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Разговор идёт по версии 1: карточка показывает его и ноду
  await page.reload();
  const card = page.getByTestId("chat-migration");
  await expect(card.getByRole("list", { name: "Разговоры по нодам" })).toHaveText("«Разговор» — 1 разговор");
  await card.getByRole("button", { name: "Перевести на новую версию" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Перевести 1 разговор?")).toBeVisible();
  await expect(dialog.getByText("Люди продолжат с той же ноды по новым правилам.")).toBeVisible();
  await dialog.getByRole("button", { name: "Перевести", exact: true }).click();
  await expect(card.getByText("1 разговор продолжат по новой версии со следующего сообщения.")).toBeVisible({ timeout: 30_000 });

  const [passage] = await db.select().from(passages).where(eq(passages.leadMagnetId, lead.id));
  const published = (await getLeadMagnet(db, lead.id))!.publishedSnapshotId;
  expect(passage!.snapshotId).toBe(published);
  // Работник перевёл чат в сценарии SDK — карточка исчезает
  await expect
    .poll(async () => (await connection.pool.query("select version_id from agent_chat.flow_chats where chat_id = $1", [passage!.chatId])).rows[0]?.version_id, { timeout: 30_000 })
    .toBe(published);
  await page.reload();
  await expect(page.getByTestId("chat-migration")).toHaveCount(0);

  await say("Что дальше?");
  await expect.poll(lastSent, { timeout: 30_000 }).toBe(E2E_SCRIPT.newVersionReply);

  // Перевод виден в «Логе»
  await page.goto(`/lead-magnets/${lead.id}`);
  await page.getByRole("tab", { name: "Лог" }).click();
  const entry = page.getByRole("tabpanel", { name: "Лог" }).getByTestId("log-migration");
  await expect(entry).toContainText("Перевод на новую версию: 1 разговор");
  await expect(entry).toContainText(`Перевёл: ${E2E_EMAIL}`);
  await expect(entry).toContainText("«Разговор» → «Разговор»: 1 разговор");
});
