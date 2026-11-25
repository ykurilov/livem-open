import { expect, test, type Locator, type Page } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL } from "./e2e-env";
import { openConstructor, openCreateForm } from "./open-tab";

test.beforeEach(async ({ context }) => {
  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
});

/** Пишет конструктору и ждёт его ответ. Ввод до того, как поле достроилось, пропадает: повторяем, пока «Отправить» не станет доступна. */
async function say(constructor: Locator, text: string) {
  const input = constructor.getByRole("textbox");
  await expect(async () => {
    await input.fill(text);
    await expect(constructor.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await input.press("Enter");
  await expect(feed(constructor).getByText(text, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(constructor.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.constructorDone }).last()).toBeVisible({ timeout: 60_000 });
}

/** Лента открытого чата: название чата в шапке панели тоже бывает этим текстом. */
const feed = (constructor: Locator) => constructor.getByRole("log");

async function openList(constructor: Locator): Promise<Locator> {
  const toggle = constructor.getByRole("button", { name: "Чаты конструктора" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const list = constructor.getByRole("navigation", { name: "Чаты" });
  await expect(list).toBeVisible();
  return list;
}

/** Снимки для отчёта: светлая и тёмная тема панели. */
async function shootThemes(page: Page, target: Locator, name: string) {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await target.screenshot({ path: test.info().outputPath(`cchats-${name}-${colorScheme}.png`), animations: "disabled" });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const FIRST = `${E2E_SCRIPT.slowTrigger}: сделай знакомство`;

test("чаты конструктора: новый чат → написать → вернуться к старому → переименовать → удалить", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/");
  await openCreateForm(page);
  await page.getByLabel("Название").fill("Лидмагнит с несколькими чатами");
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page).toHaveURL(/\/lead-magnets\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const constructor = page.getByRole("region", { name: "Конструктор", exact: true });

  // Пока конструктор отвечает, чат не сменить и новый не завести: черновик правит идущий ход, а замок правок видит только открытый чат
  const input = constructor.getByRole("textbox");
  await expect(async () => {
    await input.fill(FIRST);
    await expect(constructor.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await input.press("Enter");
  await expect(constructor.getByRole("button", { name: "Чаты конструктора" })).toBeDisabled();
  await expect(constructor.getByRole("button", { name: "Новый чат с конструктором" })).toBeDisabled();
  await expect(constructor.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.constructorDone })).toBeVisible({ timeout: 60_000 });
  await expect(constructor.getByRole("button", { name: "Чаты конструктора" })).toBeEnabled({ timeout: 45_000 });

  // Новый чат: пустая лента, прежняя переписка не видна
  await constructor.getByRole("button", { name: "Новый чат с конструктором" }).click();
  await expect(feed(constructor).getByText(FIRST, { exact: true })).toBeHidden({ timeout: 15_000 });
  await say(constructor, "второй разговор");
  await expect(feed(constructor).getByText(FIRST, { exact: true })).toBeHidden();

  // В списке оба чата; открытый отмечен
  let list = await openList(constructor);
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.locator("[aria-current=true]")).toHaveCount(1);
  await shootThemes(page, constructor, "list");

  // Возврат к старому чату: его переписка на месте
  await list.getByRole("listitem").filter({ hasNot: page.locator("[aria-current=true]") }).getByRole("button").first().click();
  await expect(list).toBeHidden();
  await expect(feed(constructor).getByText(FIRST, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(feed(constructor).getByText("второй разговор", { exact: true })).toBeHidden();

  // Переименование открытого чата: новое название в шапке панели
  list = await openList(constructor);
  const active = list.getByRole("listitem").filter({ has: page.locator("[aria-current=true]") });
  await active.getByRole("button", { name: /^Действия с чатом/ }).click();
  await page.getByRole("menuitem", { name: "Переименовать" }).click();
  const field = list.getByRole("textbox", { name: "Название чата" });
  await field.fill("Первая тема");
  await field.press("Enter");
  await expect(list.getByRole("button", { name: "Первая тема", exact: true })).toBeVisible();

  // Удаление второго чата — после подтверждения
  const second = list.getByRole("listitem").filter({ hasNot: page.locator("[aria-current=true]") });
  await second.getByRole("button", { name: /^Действия с чатом/ }).click();
  await page.getByRole("menuitem", { name: "Удалить" }).click();
  const confirm = page.getByRole("dialog", { name: "Удалить чат?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(list.getByRole("listitem")).toHaveCount(1);

  // После перезагрузки открыт тот же чат, а удалённого нет. У лидмагнита уже есть черновик: панель открывается кнопкой
  await page.reload();
  await openConstructor(page);
  await expect(constructor.getByRole("button", { name: "Чаты конструктора" })).toContainText("Первая тема", { timeout: 30_000 });
  await expect(feed(constructor).getByText(FIRST, { exact: true })).toBeVisible({ timeout: 15_000 });
  list = await openList(constructor);
  await expect(list.getByRole("listitem")).toHaveCount(1);

  // Узкий экран телефона: панель на весь экран, список помещается
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list).toBeVisible();
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.screenshot({ path: test.info().outputPath(`cchats-narrow-${colorScheme}.png`), animations: "disabled" });
  }
});
