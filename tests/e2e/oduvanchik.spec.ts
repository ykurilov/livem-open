import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { createLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { connectDatabase } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
  test(`Одуванчик: ${theme}, ${width}px - кабинет, формы, навигация и чат`, async ({ page, context }) => {
    test.setTimeout(120_000);
    const connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 1 });
    try {
      const lead = await createLeadMagnet(connection.db, { name: "Твоё первое приложение" });
      await saveDraft(connection.db, lead.id, { ...lead.draft, firstMessage: "Здравствуйте! Что вы хотите создать?", instruction: "Помоги человеку выбрать идею" }, "manual");
      const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
      await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(value => localStorage.setItem("theme", value), theme);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { name: "Лидмагниты", exact: true })).toBeVisible();
      await expect(page.getByLabel("Название", { exact: true })).toBeVisible();
      const create = page.getByRole("button", { name: "Создать", exact: true });
      await expect(create).toHaveClass(/yk-button--primary/);
      await expect(create).toHaveCSS("background-color", theme === "light" ? "rgb(20, 20, 20)" : "rgb(242, 242, 240)");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`oduvanchik-home-${theme}-${width}.png`) });
      if (width === 390) {
        await page.getByRole("button", { name: "Открыть меню" }).click();
        const menu = page.getByRole("dialog", { name: "Разделы кабинета" });
        await expect(menu).toBeVisible();
        await menu.getByRole("link", { name: "Настройки", exact: true }).click();
        await expect(menu).toBeHidden();
      } else {
        // Меню раскрывается с названиями разделов, выбор переживает перезагрузку
        const navigation = page.getByRole("navigation", { name: "Разделы кабинета" });
        // Клик до гидратации страницы пропадает: повторяем, пока меню не раскроется
        await expect(async () => {
          await navigation.getByRole("button", { name: "Раскрыть меню" }).click({ timeout: 1000 });
          await expect(navigation.getByText("Лидмагниты", { exact: true })).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 30_000 });
        await page.reload();
        await expect(navigation.getByRole("button", { name: "Свернуть меню" })).toHaveAttribute("aria-expanded", "true");
        await page.screenshot({ path: test.info().outputPath(`oduvanchik-menu-${theme}-${width}.png`) });
        await navigation.getByRole("button", { name: "Свернуть меню" }).click();
        await expect(navigation.getByText("Лидмагниты", { exact: true })).toBeHidden();
        await page.getByRole("link", { name: "Настройки", exact: true }).click();
      }
      await expect(page.getByRole("heading", { name: "Настройки", exact: true })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`oduvanchik-settings-${theme}-${width}.png`) });
      const response = await page.goto(`/lead-magnets/${lead.id}`);
      expect(response?.status()).toBe(200);
      await page.getByRole("tab", { name: "Разговор", exact: true }).click();
      const chat = page.getByRole("tabpanel", { name: "Разговор", exact: true });
      await expect(chat.locator(".oduvanchik-field textarea")).toBeVisible();
      await expect(chat.getByRole("paragraph").filter({ hasText: "Здравствуйте! Что вы хотите создать?" })).toBeVisible({ timeout: 30_000 });
      await expect(chat.locator(".oduvanchik-field")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`oduvanchik-chat-${theme}-${width}.png`) });
      expect(errors).toEqual([]);
    } finally { await connection.close(); }
  });
}

test("Одуванчик: подтверждение удаления поля, Esc и возврат фокуса", async ({ page, context }) => {
  const { createField } = await import("../../src/modules/people");
  const connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 1 });
  try {
    const name = `Поле проверки ${Date.now()}`;
    await createField(connection.db, { name, type: "text", description: "Для проверки формы" });
    const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
    await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
    await page.goto("/fields");
    const trigger = page.getByRole("button", { name: `Удалить поле «${name}»`, exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: `Удалить поле «${name}»?`, exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole("button", { name: "Удалить поле", exact: true }).click();
    await expect(trigger).toHaveCount(0);
  } finally { await connection.close(); }
});
