import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL } from "./e2e-env";

test.beforeEach(async ({ context }) => {
  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
});

test("удалённый лидмагнит из закладки — русская страница внутри кабинета с меню и путём к лидмагнитам; чужой адрес — тоже по-русски", async ({ page }) => {
  await page.goto(`/lead-magnets/${randomUUID()}`);
  await expect(page.getByText("Здесь ничего нет")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Разделы кабинета" })).toBeVisible();
  await page.getByRole("link", { name: "К лидмагнитам" }).click();
  await expect(page.getByRole("heading", { name: "Лидмагниты", level: 1 })).toBeVisible();

  await page.goto(`/no-such-page-${randomUUID().slice(0, 6)}`);
  await expect(page.getByText("Такой страницы нет")).toBeVisible();
  await expect(page.getByRole("link", { name: "На главную" })).toBeVisible();
});

test("переход по меню, пока страница считается, сразу виден полоской вверху окна", async ({ page }) => {
  // Первый показ страницы `next dev` собирает долго: собираем заранее, чтобы ждать только задержку ниже
  await page.goto("/knowledge");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Лидмагниты", level: 1 })).toBeVisible();
  // Сервер «думает» над «Базой знаний» секунду: так заметно, есть ли отклик до прихода страницы
  await page.route(
    (url) => url.pathname === "/knowledge",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    },
  );
  await page.getByRole("navigation", { name: "Разделы кабинета" }).getByRole("link", { name: "База знаний" }).click();
  await expect(page.locator(".app-navigation-progress")).toBeVisible({ timeout: 1_000 });
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(page.locator(".app-navigation-progress")).toHaveCount(0);
});
