import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { inboundMessages } from "../../src/modules/conversations/schema";
import { people } from "../../src/modules/people/schema";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";

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

test("черновик ответа не переходит к другому собеседнику, даже если их сообщения пришли в одну и ту же секунду", async ({ page }) => {
  const { db } = connection;
  const tag = Date.now().toString(36);
  const token = `fake-draft${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот черновика ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_draft${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  const names = [`Аня ${tag}`, `Боря ${tag}`];
  const persons = await db
    .insert(people)
    .values(names.map((displayName, index) => ({ channel: "telegram" as const, botId: bot!.id, externalUserId: `draft-${tag}-${index}`, displayName })))
    .returning();
  // Одинаковое время последнего сообщения у обоих
  const at = new Date();
  await db.insert(inboundMessages).values(
    persons.map((person, index) => ({
      botId: bot!.id,
      kind: "message" as const,
      dedupeKey: `draft:${tag}:${index}`,
      externalUserId: person.externalUserId,
      text: `Вопрос от ${person.displayName}`,
      personId: person.id,
      route: "inbox" as const,
      receivedAt: at,
      processedAt: at,
    })),
  );

  const threads = page.getByRole("navigation", { name: "Неотвеченные" });
  await page.goto("/inbox");
  await threads.getByRole("link", { name: new RegExp(names[0]!) }).click();
  await expect(page.getByTestId("inbox-messages")).toContainText(`Вопрос от ${names[0]}`);
  await page.getByLabel("Ваш ответ").fill("Черновик для Ани");

  await threads.getByRole("link", { name: new RegExp(names[1]!) }).click();
  await expect(page.getByTestId("inbox-messages")).toContainText(`Вопрос от ${names[1]}`);
  await expect(page.getByLabel("Ваш ответ")).toHaveValue("");
});
