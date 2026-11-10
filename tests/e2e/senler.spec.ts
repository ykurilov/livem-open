import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { senlerConnections } from "../../src/modules/senler/schema";
import { FAKE_SENLER_KEY } from "../../src/modules/senler/fake-senler-api";
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

test("Senler у бота ВК: неверный ключ — понятная ошибка, верный — группы из Senler, выбор группы сохраняется", async ({ page }) => {
  const { db } = connection;
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Бот ВК — сразу в базе: подключение ботов проверяют другие сценарии
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "vk",
      title: `Сообщество ${tag}`,
      externalId: String(Math.floor(Math.random() * 1e9)),
      username: `club_senler${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(`fake-vk-${tag}`),
      webhookSecret: `secret-${tag}`,
    })
    .returning();

  await page.goto(`/bots/${bot!.id}`);
  await page.getByLabel("Ключ Senler").fill("wrong-key");
  await page.getByRole("button", { name: "Подключить Senler" }).click();
  await expect(page.getByText("Senler не принял ключ")).toBeVisible({ timeout: 60_000 });

  await page.getByLabel("Ключ Senler").fill(FAKE_SENLER_KEY);
  await page.getByRole("button", { name: "Подключить Senler" }).click();
  const groupSelect = page.getByLabel("Группа Senler по умолчанию");
  await expect(groupSelect).toBeVisible({ timeout: 60_000 });
  // Принятый ключ убран с экрана
  await expect(page.getByText("Ключ Senler принят")).toBeVisible();
  await expect(page.getByLabel("Новый ключ Senler")).toHaveValue("");
  await expect(groupSelect.locator("option")).toHaveText(["Не добавлять", "Подписчики марафона", "Весенний интенсив"]);

  await groupSelect.selectOption({ label: "Весенний интенсив" });
  await page.getByRole("button", { name: "Сохранить группы" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => (await db.select().from(senlerConnections).where(eq(senlerConnections.botId, bot!.id)))[0]?.defaultGroupId)
    .toBe("102");
  // Ключ в базе — только зашифрованным
  const [row] = await db.select().from(senlerConnections).where(eq(senlerConnections.botId, bot!.id));
  expect(row!.apiKeyEncrypted).not.toContain(FAKE_SENLER_KEY);

  await page.getByRole("button", { name: "Отключить Senler" }).click();
  await expect(page.getByRole("button", { name: "Подключить Senler" })).toBeVisible({ timeout: 60_000 });
  await expect(groupSelect).toBeHidden();
});
