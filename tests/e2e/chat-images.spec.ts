import { expect, test, type Locator } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { openTab } from "./open-tab";
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

// Настоящая PNG 1×1: сервер проверяет тип по содержимому
const SCREENSHOT_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Ctrl+V снимка экрана в поле ввода: браузер отдаёт картинку событием вставки. */
async function pasteScreenshot(input: Locator) {
  await input.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, SCREENSHOT_BASE64);
}

test("картинка из буфера доходит до конструктора; консультант принимает картинки, только когда их включили", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/");
  await page.getByRole("button", { name: "Новый лидмагнит" }).click();
  await page.getByLabel("Название").fill("Лидмагнит с картинками");
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page).toHaveURL(/\/lead-magnets\/[0-9a-f-]{36}$/, { timeout: 60_000 });

  // Конструктор: вставка снимка экрана, модель получает его в сообщении
  const constructor = page.getByRole("region", { name: "Конструктор", exact: true });
  const constructorInput = constructor.getByRole("textbox");
  // Сначала черновик: без первого сообщения проверять нечего. Ввод до того, как поле достроилось, пропадает
  await expect(async () => {
    await constructorInput.fill("сделай");
    await expect(constructor.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await constructorInput.press("Enter");
  await expect(page.getByRole("button", { name: "Начать заново" })).toBeVisible({ timeout: 30_000 });
  await expect(constructorInput).toBeEnabled({ timeout: 30_000 });
  await pasteScreenshot(constructorInput);
  await constructorInput.fill("Посмотри мой экран");
  await expect(constructor.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 30_000 });
  await constructorInput.press("Enter");
  await expect(constructor.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.imageSeen })).toBeVisible({ timeout: 30_000 });

  // Проверка: по умолчанию прикрепить нечего — поле ввода без кнопки файла
  await openTab(page, "Разговор");
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  const previewInput = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(previewInput).toBeVisible({ timeout: 30_000 });
  await expect(preview.locator('input[type="file"]')).toHaveCount(0);

  // Включили в настройках — снимок клиента доходит до консультанта
  await openTab(page, "Настройки");
  await page.getByRole("checkbox", { name: /Консультант принимает картинки клиента/ }).check();
  const save = page.getByRole("button", { name: "Сохранить" });
  await save.click();
  await expect(save).toBeDisabled();

  await openTab(page, "Разговор");
  await page.getByRole("button", { name: "Начать заново" }).click();
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.firstMessage })).toBeVisible({ timeout: 30_000 });
  await expect(preview.locator('input[type="file"]')).toHaveCount(1, { timeout: 30_000 });
  await preview.locator('input[type="file"]').setInputFiles({ name: "client.png", mimeType: "image/png", buffer: Buffer.from(SCREENSHOT_BASE64, "base64") });
  await expect(async () => {
    await previewInput.fill("Вот что у меня на экране");
    await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await previewInput.press("Enter");
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.imageSeen })).toBeVisible({ timeout: 30_000 });
});
