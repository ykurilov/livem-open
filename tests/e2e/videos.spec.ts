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

test("эксперт добавляет ролик, разрешает его лидмагниту, и в проверке консультант показывает карточку", async ({ page }) => {
  test.setTimeout(180_000);
  // Название начинается со слова из запроса тестовой модели, хвост — чтобы не спутать с роликами соседних прогонов
  const title = `Упаковка экспертизы ${randomUUID().slice(0, 6)}`;

  await page.goto("/videos");
  await page.getByRole("button", { name: "Добавить ролик" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Ссылка").fill("https://vimeo.com/123");
  await form.getByLabel("Название").fill(title);
  await form.getByLabel("О чём ролик").fill("Как описать, что вы делаете.");
  await form.getByRole("button", { name: "Сохранить" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "Нужна ссылка на ролик YouTube или Kinescope" })).toBeVisible();
  // Набранное при ошибке не пропадает
  await expect(form.getByLabel("Название")).toHaveValue(title);
  await form.getByLabel("Ссылка").fill("https://youtu.be/aircAruvnKk");
  await form.getByRole("button", { name: "Сохранить" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  await page.goto("/");
  await page.getByLabel("Название").fill("Лидмагнит с видео");
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
  // Сохранилось — черновик обновился, правок в форме нет
  await expect(save).toBeDisabled();

  await page.getByRole("tab", { name: "Разговор" }).click();
  await page.getByRole("button", { name: "Начать проверку заново" }).click();
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  // Перезапуск проверки под нагрузкой полного прогона идёт дольше 5 с
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.firstMessage })).toBeVisible({ timeout: 30_000 });
  const previewInput = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await previewInput.fill(`Покажи ${E2E_SCRIPT.videoTrigger}`);
  await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  await previewInput.press("Enter");
  await expect(preview.getByRole("button", { name: new RegExp(`: ${title}$`) })).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.videoReply })).toBeVisible();

  // В «Логе» ролик — ссылкой, а не сырым ответом инструмента
  await page.getByRole("tab", { name: "Лог" }).click();
  const log = page.getByRole("tabpanel", { name: "Лог" });
  const turn = log.getByRole("list", { name: "Ходы агентов" }).getByRole("listitem").filter({ hasText: "Проверка" }).first();
  const toolCall = turn.locator("summary").filter({ hasText: "Инструмент · show_video" });
  await expect(toolCall).toBeVisible({ timeout: 10_000 });
  await toolCall.click();
  await expect(turn.getByRole("link", { name: title })).toBeVisible();
});
