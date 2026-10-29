import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
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

// Настоящая PNG 1×1: экран чата её загружает и рисует
const SCREENSHOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("эксперт загружает скриншот, разрешает его лидмагниту, и в проверке консультант его показывает", async ({ page }) => {
  test.setTimeout(180_000);
  // Хвост — чтобы не спутать с картинками соседних прогонов
  const title = `Готовое приложение ${randomUUID().slice(0, 6)}`;
  // В описании слово из запроса тестовой модели: по нему консультант картинку и находит
  const description = `Где нажать: ${E2E_SCRIPT.imageQuery} слева, ${title}.`;

  await page.goto("/images");
  await page.getByRole("button", { name: "Добавить картинку" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Название").fill(title);
  await form.getByLabel("Когда показывать").fill(description);
  await form.getByRole("button", { name: "Сохранить" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "Выберите картинку" })).toBeVisible();
  // Набранное при ошибке не пропадает
  await expect(form.getByLabel("Название")).toHaveValue(title);
  await form.getByLabel("Файл картинки").setInputFiles({ name: "скриншот.png", mimeType: "image/png", buffer: SCREENSHOT });
  await form.getByRole("button", { name: "Сохранить" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  await page.goto("/");
  await page.getByLabel("Название").fill("Лидмагнит со скриншотом");
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page).toHaveURL(/\/lead-magnets\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const constructorInput = page.getByRole("region", { name: "Конструктор" }).getByRole("textbox");
  await constructorInput.fill("сделай");
  await expect(page.getByRole("region", { name: "Конструктор", exact: true }).getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  await constructorInput.press("Enter");
  await expect(page.getByRole("button", { name: "Начать проверку заново" })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("tab", { name: "Настройки" }).click();
  await page.getByRole("checkbox", { name: new RegExp(title) }).check();
  const save = page.getByRole("button", { name: "Сохранить" });
  await save.click();
  await expect(save).toBeDisabled();

  await page.getByRole("tab", { name: "Разговор" }).click();
  await page.getByRole("button", { name: "Начать проверку заново" }).click();
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.firstMessage })).toBeVisible({ timeout: 30_000 });
  const previewInput = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await previewInput.fill(`Пришли ${E2E_SCRIPT.imageTrigger}, где моё приложение`);
  await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  await previewInput.press("Enter");
  // Картинка — с названием подписью; открыть крупно можно по описанию
  const figure = preview.getByRole("figure", { name: title });
  await expect(figure.getByRole("button", { name: `Открыть картинку: ${description}` })).toBeVisible({ timeout: 30_000 });
  const shown = figure.locator("img");
  // Файл отдался по адресу архива и нарисовался, а не битая картинка
  await expect.poll(() => shown.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(1);
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.imageReply })).toBeVisible();
});
