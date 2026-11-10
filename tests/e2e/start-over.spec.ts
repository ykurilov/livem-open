import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { passages } from "../../src/modules/conversations/schema";
import { createLeadMagnet, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
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

test("«Начать заново» в карточке: подтверждение, разговор закрыт, ссылка начинает новый", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { db } = connection;
  const tag = Date.now().toString(36);
  const token = `fake-startover${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот сброса ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_startover${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  const lead = await createLeadMagnet(db, { name: `Сброс ${tag}` });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
  const { code } = await publishWithBots(db, lead.id, { telegram: bot!.id });

  let update = 0;
  const say = async (text: string, startCode?: string) => {
    const response = await request.post(`/api/webhooks/telegram/${bot!.id}`, {
      headers: { ...FRESH_CONNECTION, "x-fake-secret": bot!.webhookSecret },
      data: { events: [{ type: "message", dedupeKey: `startover:${tag}:${++update}`, userId: "vera", userName: `Вера ${tag}`, text, ...(startCode && { startCode }) }] },
    });
    expect(response.status()).toBe(200);
  };
  const statuses = async () => {
    const [person] = await db.select().from(people).where(and(eq(people.botId, bot!.id), eq(people.externalUserId, "vera")));
    if (!person) return [];
    return (await db.select().from(passages).where(eq(passages.personId, person.id)).orderBy(passages.startedAt)).map((row) => row.status);
  };

  await say(`/start ${code}`, code);
  await expect.poll(statuses, { timeout: 30_000 }).toEqual(["active"]);
  const [person] = await db.select().from(people).where(and(eq(people.botId, bot!.id), eq(people.externalUserId, "vera")));

  await page.goto(`/people/${person!.id}`);
  // Страница человека в `next dev` может собираться впервые
  await expect(page.getByRole("heading", { name: `Вера ${tag}` })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: test.info().outputPath("start-over-button.png") });
  await page.getByRole("button", { name: "Начать заново" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("с чистого листа");
  await page.screenshot({ path: test.info().outputPath("start-over-confirm.png") });
  await dialog.getByRole("button", { name: "Начать заново" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(statuses).toEqual(["not_completed"]);
  await expect(page.getByTestId("person-passage")).toContainText("Не завершил");

  await say(`/start ${code}`, code);
  await expect.poll(statuses, { timeout: 30_000 }).toEqual(["not_completed", "active"]);
});
