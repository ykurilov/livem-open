import { expect, test } from "@playwright/test";
import { setPassword } from "../../src/modules/accounts";
import { connectDatabase } from "../../src/modules/platform/db";
import { E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

const PASSWORD = "e2e-password-not-secret";

test.beforeAll(async () => {
  const connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 1 });
  await setPassword(connection.db, { email: E2E_EMAIL, password: PASSWORD, allowedEmails: new Set([E2E_EMAIL]) });
  await connection.close();
});

test("владелец входит по почте и паролю, выходит, и неверный пароль не пускает", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);

  await page.getByLabel("Почта").fill(E2E_EMAIL);
  await page.getByLabel("Пароль").fill("wrong-password");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText("Неверная почта или пароль")).toBeVisible();

  await page.getByLabel("Почта").fill(E2E_EMAIL);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.goto("/api/auth/logout");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
});
