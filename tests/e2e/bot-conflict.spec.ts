import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

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

test("бот занят другим сервисом: предупреждение, «Отмена» ничего не подключает, «Подключить всё равно» подключает", async ({ page }) => {
  const { db } = connection;
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const username = `bot_busy-${tag}`;
  const botsNamed = () => db.select().from(bots).where(eq(bots.username, username));

  await page.goto("/bots");
  await page.getByLabel("Токен бота").fill(`fake-busy-${tag}`);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();

  const warning = page.getByText("Бот сейчас занят другой программой");
  await expect(warning).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Подключить всё равно" })).toBeVisible();
  expect(await botsNamed()).toHaveLength(0);

  await page.getByRole("button", { name: "Отмена" }).click();
  await expect(warning).toBeHidden();
  expect(await botsNamed()).toHaveLength(0);

  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(warning).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Подключить всё равно" }).click();
  await expect(page.getByText("Бот подключён")).toBeVisible({ timeout: 60_000 });
  await expect(warning).toBeHidden();
  expect(await botsNamed()).toHaveLength(1);
});
