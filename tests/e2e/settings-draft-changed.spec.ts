import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL } from "./e2e-env";
import { openTab } from "./open-tab";

test.beforeEach(async ({ context }) => {
  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
});

test("новая версия черновика из другой вкладки не стирает недописанную правку «Настроек»", async ({ page, context }) => {
  test.setTimeout(180_000);

  await page.goto("/");
  await page.getByRole("button", { name: "Новый лидмагнит" }).click();
  await page.getByLabel("Название").fill("Лидмагнит в двух вкладках");
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page).toHaveURL(/\/lead-magnets\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const constructor = page.getByRole("region", { name: "Конструктор", exact: true });
  const constructorInput = constructor.getByRole("textbox");
  // Ввод до того, как поле достроилось, пропадает: повторяем, пока «Отправить» не станет доступна
  await expect(async () => {
    await constructorInput.fill("сделай");
    await expect(constructor.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await constructorInput.press("Enter");
  await expect(constructor.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.constructorDone })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Начать заново" }).click({ timeout: 30_000 });
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.firstMessage })).toBeVisible({ timeout: 45_000 });

  // Эксперт начал правку в «Настройках» этой вкладки
  await openTab(page, "Настройки");
  const description = page.getByLabel("Описание карточки");
  await description.fill("Правка из этой вкладки");

  // Тем временем черновик меняется в другой вкладке
  const other = await context.newPage();
  await other.goto(page.url());
  await openTab(other, "Настройки");
  await other.getByLabel("Прощальное сообщение").fill("Пока из другой вкладки");
  await other.getByRole("button", { name: "Сохранить" }).click();
  await expect(other.getByText("Сохранено")).toBeVisible({ timeout: 30_000 });
  await other.close();

  // Ход тестового разговора закончился — страница дочитала новую версию черновика
  await openTab(page, "Разговор");
  const previewInput = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(async () => {
    await previewInput.fill("Я коуч");
    await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await previewInput.press("Enter");
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.consultantReply })).toBeVisible({ timeout: 30_000 });

  await openTab(page, "Настройки");
  const farewell = page.getByLabel("Прощальное сообщение");
  await expect(farewell).toHaveValue("Пока из другой вкладки", { timeout: 30_000 });
  await expect(description).toHaveValue("Правка из этой вкладки");
  await expect(page.getByText("Пока вы правили, черновик изменился")).toBeVisible();

  // Сохранение кладёт правку поверх новой версии, ничего из неё не теряя
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Пока вы правили, черновик изменился")).toBeHidden();
  await page.reload();
  await openTab(page, "Настройки");
  await expect(page.getByLabel("Описание карточки")).toHaveValue("Правка из этой вкладки");
  await expect(page.getByLabel("Прощальное сообщение")).toHaveValue("Пока из другой вкладки");
});
