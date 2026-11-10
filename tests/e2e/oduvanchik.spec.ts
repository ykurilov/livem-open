import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { createLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { connectDatabase } from "../../src/modules/platform/db";
import { openTab } from "./open-tab";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

// Сценарий проходит один раз на экран: компьютер и телефон в светлой теме. Тёмная тема — главная страница: цвета и снимок
const CASES = [
  { width: 1440, theme: "light", full: true },
  { width: 390, theme: "light", full: true },
  { width: 1440, theme: "dark", full: false },
] as const;
for (const { width, theme, full } of CASES) {
  test(`Одуванчик: ${theme}, ${width}px - ${full ? "кабинет, формы, навигация и чат" : "главная"}`, async ({ page, context }) => {
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
      // Форма создания скрыта за кнопкой в шапке и не отодвигает список; пустое название ловит своя подсказка, а не браузер
      await expect(page.getByLabel("Название", { exact: true })).toBeHidden();
      await page.getByRole("button", { name: "Новый лидмагнит" }).click();
      await expect(page.getByLabel("Название", { exact: true })).toBeFocused();
      const create = page.getByRole("button", { name: "Создать", exact: true });
      await expect(create).toHaveClass(/yk-button--primary/);
      await expect(create).toHaveCSS("background-color", theme === "light" ? "rgb(20, 20, 20)" : "rgb(242, 242, 240)");
      await create.click();
      await expect(page.getByText("Напишите название лидмагнита")).toBeVisible();
      await expect(page.getByLabel("Название", { exact: true })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`oduvanchik-home-${theme}-${width}.png`) });
      if (!full) return;
      if (width === 390) {
        await page.getByRole("button", { name: "Открыть меню" }).click();
        const menu = page.getByRole("dialog", { name: "Разделы кабинета" });
        await expect(menu).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`oduvanchik-menu-${theme}-${width}.png`) });
        // Настройки — шестерёнка внизу панели, раздела в списке нет
        await expect(menu.getByRole("link", { name: "Настройки", exact: true })).toHaveCount(0);
        await menu.getByRole("button", { name: "Настройки", exact: true }).click();
        await expect(menu).toBeHidden();
      } else {
        // Меню раскрыто с названиями разделов, свёрнутое переживает перезагрузку
        const navigation = page.getByRole("navigation", { name: "Разделы кабинета" });
        await expect(navigation.getByText("Лидмагниты", { exact: true })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`oduvanchik-menu-${theme}-${width}.png`) });
        // Клик до гидратации страницы пропадает: повторяем, пока меню не свернётся
        await expect(async () => {
          await page.getByRole("button", { name: "Свернуть меню" }).click({ timeout: 1000 });
          await expect(navigation.getByText("Лидмагниты", { exact: true })).toBeHidden({ timeout: 1000 });
        }).toPass({ timeout: 30_000 });
        await page.reload();
        await expect(page.getByRole("button", { name: "Раскрыть меню" })).toHaveAttribute("aria-expanded", "false");
        await expect(navigation.getByRole("link", { name: "Лидмагниты", exact: true })).toHaveAttribute("aria-current", "page");
        await page.screenshot({ path: test.info().outputPath(`oduvanchik-menu-collapsed-${theme}-${width}.png`) });
        await page.getByRole("button", { name: "Раскрыть меню" }).click();
        await expect(navigation.getByText("Лидмагниты", { exact: true })).toBeVisible();
        // Выход — в меню аккаунта: аватар с почтой внизу панели
        await page.getByRole("button", { name: E2E_EMAIL }).click();
        await expect(page.getByRole("menuitem", { name: "Выйти" })).toBeVisible();
        await expect(navigation.getByRole("link", { name: "Настройки", exact: true })).toHaveCount(0);
        await page.getByRole("menuitem", { name: "Настройки" }).click();
      }
      await expect(page.getByRole("heading", { name: "Настройки", exact: true })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`oduvanchik-settings-${theme}-${width}.png`) });
      if (width === 1440 && theme === "light") {
        // Тема выбирается в настройках: сразу применяется и запоминается; «Как в системе» отдаёт её устройству
        const themes = page.getByRole("radiogroup", { name: "Тема" });
        await expect(themes.getByRole("radio", { name: "Светлая" })).toBeChecked();
        await themes.getByRole("radio", { name: "Тёмная" }).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe("dark");
        await themes.scrollIntoViewIfNeeded();
        await page.screenshot({ path: test.info().outputPath("oduvanchik-settings-theme.png"), animations: "disabled" });
        await themes.getByRole("radio", { name: "Как в системе" }).click();
        await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
        expect(await page.evaluate(() => localStorage.getItem("theme"))).toBeNull();
      }
      const response = await page.goto(`/lead-magnets/${lead.id}`);
      expect(response?.status()).toBe(200);
      const chat = page.getByRole("tabpanel", { name: "Разговор", exact: true });
      await openTab(page, "Разговор", chat.getByRole("paragraph").filter({ hasText: "Здравствуйте! Что вы хотите создать?" }));
      await expect(chat.locator(".oduvanchik-field textarea")).toBeVisible();
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
