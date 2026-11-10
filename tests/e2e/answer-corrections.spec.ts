import { expect, test, type Page } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { seedCorrections } from "../../src/modules/corrections/test-fixtures";
import { createLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";
import { openConstructor, openTab } from "./open-tab";

let connection: DatabaseConnection;

// Значок разработки Next в углу появляется не в каждом прогоне: на снимках его нет
const hideDevIndicator = (page: Page) => page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

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

test("«Разобрать правки (2)» у поля конструктора: нажатие отправляет просьбу", async ({ page }) => {
  test.setTimeout(180_000);
  const lead = await createLeadMagnet(connection.db, { name: "Лидмагнит с правками" });
  await saveDraft(connection.db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: "Здравствуйте!" }, "manual");
  await seedCorrections(connection.db, lead.id, [
    { originalText: "Длинный ответ про всё сразу.", correctedText: "Короткий ответ." },
    { originalText: "Ещё один длинный ответ.", correctedText: "Ещё короче." },
  ]);

  await page.goto(`/lead-magnets/${lead.id}`);
  const constructor = await openConstructor(page);
  const button = constructor.getByRole("button", { name: "Разобрать правки (2)" });
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(button).toBeEnabled({ timeout: 30_000 });

  await hideDevIndicator(page);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(constructor).toHaveScreenshot(`answer-corrections-button-${colorScheme}.png`, { animations: "disabled", caret: "hide" });
  }

  await button.click();
  await expect(constructor.getByText("Разбери правки ответов консультанта.")).toBeVisible({ timeout: 30_000 });
  await expect(constructor.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.constructorDone })).toBeVisible({ timeout: 60_000 });
});

test("без неразобранных правок кнопки нет", async ({ page }) => {
  test.setTimeout(120_000);
  const lead = await createLeadMagnet(connection.db, { name: "Лидмагнит без правок" });
  await saveDraft(connection.db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: "Здравствуйте!" }, "manual");
  await page.goto(`/lead-magnets/${lead.id}`);
  const constructor = await openConstructor(page);
  await expect(constructor.getByRole("textbox")).toBeVisible({ timeout: 30_000 });
  await expect(constructor.getByRole("button", { name: /Разобрать правки/ })).toHaveCount(0);
});

async function closeConstructor(page: Page) {
  const panel = page.getByRole("region", { name: "Конструктор", exact: true });
  await expect(async () => {
    if (await panel.isVisible()) await page.getByRole("button", { name: "Конструктор", exact: true }).click({ timeout: 2000 });
    await expect(panel).toBeHidden({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
}

test("«Поправить» в «Проверке»: метка «Исправлено» переживает перезагрузку, «Убрать правку» возвращает исходный ответ", async ({ page }) => {
  test.setTimeout(180_000);
  const lead = await createLeadMagnet(connection.db, { name: "Лидмагнит для правки ответа" });
  await saveDraft(connection.db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: "Здравствуйте!" }, "manual");
  const corrected = "Расскажите, что вы уже пробовали.";

  await page.goto(`/lead-magnets/${lead.id}`);
  await openTab(page, "Разговор");
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  const previewInput = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(async () => {
    await previewInput.fill("Я коуч");
    await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await previewInput.press("Enter");
  const reply = preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.consultantReply });
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeVisible({ timeout: 30_000 });

  await preview.getByRole("button", { name: "Поправить" }).last().click();
  const editor = page.getByRole("dialog", { name: "Поправить" });
  await editor.getByRole("textbox", { name: "Поправить" }).fill(corrected);
  await editor.getByRole("textbox", { name: "Почему так лучше" }).fill("Сначала выясняем опыт человека");
  await editor.getByRole("button", { name: "Сохранить" }).click();
  await expect(editor).toBeHidden({ timeout: 30_000 });
  await expect(preview.getByRole("paragraph").filter({ hasText: corrected })).toBeVisible();
  await expect(preview.getByText("Исправлено", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect((await openConstructor(page)).getByRole("button", { name: "Разобрать правки (1)" })).toBeVisible({ timeout: 30_000 });
  await closeConstructor(page);

  await page.reload();
  await openTab(page, "Разговор");
  await expect(preview.getByRole("paragraph").filter({ hasText: corrected })).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByText("Исправлено", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Отказ сервера и обрыв связи — понятным текстом, правка на месте
  const removeUrl = /\/api\/preview\/[^/]+\/corrections\/[^/]+$/;
  await page.route(removeUrl, (route) =>
    route.fulfill({ status: 409, json: { error: { kind: "busy", message: "Дождитесь ответа консультанта и попробуйте ещё раз." } } }),
  );
  await preview.getByRole("button", { name: "Убрать правку" }).click();
  await expect(preview.getByRole("alert").filter({ hasText: "Дождитесь ответа консультанта и попробуйте ещё раз." })).toBeVisible();
  await page.unroute(removeUrl);
  await page.route(removeUrl, (route) => route.abort());
  await preview.getByRole("button", { name: "Убрать правку" }).click();
  await expect(preview.getByRole("alert").filter({ hasText: "Нет связи — правка не убрана." })).toBeVisible();
  await page.unroute(removeUrl);
  await expect(preview.getByRole("paragraph").filter({ hasText: corrected })).toBeVisible();

  await preview.getByRole("button", { name: "Убрать правку" }).click();
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByRole("alert").filter({ hasText: "правка не убрана" })).toHaveCount(0);
  await expect(preview.getByRole("paragraph").filter({ hasText: corrected })).toHaveCount(0);
  await expect(preview.getByText("Исправлено", { exact: true })).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "Убрать правку" })).toHaveCount(0);
  const constructor = await openConstructor(page);
  await expect(constructor.getByRole("textbox")).toBeVisible({ timeout: 30_000 });
  await expect(constructor.getByRole("button", { name: /Разобрать правки/ })).toHaveCount(0);
});

test("окно правки ответа на телефоне — в узкой вёрстке", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const lead = await createLeadMagnet(connection.db, { name: "Лидмагнит для правки с телефона" });
  await saveDraft(connection.db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: "Здравствуйте!" }, "manual");

  await page.goto(`/lead-magnets/${lead.id}`);
  await openTab(page, "Разговор");
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  await expect(preview.getByRole("paragraph").filter({ hasText: "Здравствуйте!" })).toBeVisible({ timeout: 30_000 });
  await preview.getByRole("button", { name: "Поправить" }).last().click();
  const editor = page.getByRole("dialog", { name: "Поправить" });
  await expect(editor.getByRole("textbox", { name: "Почему так лучше" })).toBeVisible();
  await hideDevIndicator(page);
  await expect(editor).toHaveScreenshot("answer-corrections-editor-phone.png", { animations: "disabled", caret: "hide" });
});
