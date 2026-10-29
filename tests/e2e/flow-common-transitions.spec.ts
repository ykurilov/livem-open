import { expect, test, type Locator, type Page } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { leadMagnetToFlow } from "../../src/modules/flows/settings-to-flow";
import { createLeadMagnet, getLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

let connection: DatabaseConnection;
test.beforeAll(() => { connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 }); });
test.afterAll(async () => { await connection.close(); });
test.beforeEach(async ({ context }) => {
  const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
});
async function seed() {
  const lead = await createLeadMagnet(connection.db, { name: "SDK 121 - общие переходы" });
  const settings = { ...lead.draft, firstMessage: "Здравствуйте!", instruction: "Помоги с приложением", stages: [
    { id: "meet", name: "Знакомство", instruction: "Обсуди идею", transitionCondition: "Назвал идею", startDay: null, isSale: false },
    { id: "build", name: "Сборка", instruction: "Помоги собрать", transitionCondition: "Собрал", startDay: null, isSale: false },
  ] };
  const flow = leadMagnetToFlow(settings, []);
  flow.anyState.exits.push({ id: "common_help", when: { type: "judge", text: "Человек просит помочь со сборкой" }, to: "build" });
  flow.anyState.except = ["build"];
  flow.layout["@any"] = { x: 30_000, y: 30_000 };
  await saveDraft(connection.db, lead.id, { ...settings, flow }, "manual");
  return { id: lead.id, flow };
}
async function boardOf(page: Page, id: string) {
  await page.goto(`/lead-magnets/${id}`);
  const tab = page.getByRole("tab", { name: "Сценарий" });
  await expect(async () => { await tab.click(); await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1000 }); }).toPass({ timeout: 60_000 });
  const board = page.getByRole("tabpanel", { name: "Сценарий" });
  await expect(board.getByRole("application")).toBeVisible({ timeout: 60_000 });
  await expect(board.getByText("Только просмотр")).toBeHidden({ timeout: 60_000 });
  return board;
}
async function common(page: Page, board: Locator) {
  const direct = board.getByTitle("Общие переходы", { exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await board.getByRole("button", { name: "Ещё действия", exact: true }).click();
    await page.getByRole("menuitem", { name: "Общие переходы", exact: true }).click();
  }
  const panel = board.getByRole("region", { name: "Общие переходы", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}
for (const width of [1440, 390]) test(`SDK121: compact ${width}px, правила сохраняются без anyState-ноды и публикации`, async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width, height: 900 });
  const { id, flow } = await seed();
  const board = await boardOf(page, id);
  await expect(board.locator('.react-flow__node[data-id="@any"]')).toHaveCount(0);
  await expect(board.locator(".react-flow__node")).toHaveCount(flow.states.length);
  if (width === 1440) {
    await board.locator("[data-flow-fullscreen-toggle]").click();
    await expect(board.locator('[data-flow-fullscreen][role="dialog"]')).toBeVisible();
  }
  await page.screenshot({ path: test.info().outputPath(`sdk076-canvas-${width}.png`) });
  const panel = await common(page, board);
  await panel.getByRole("button", { name: "Знакомство", exact: true }).click();
  const rule = panel.locator('[data-exit-card="common_help"]');
  await rule.getByRole("textbox", { name: "Когда", exact: true }).fill("Человек явно просит вернуться к идее");
  await rule.getByRole("combobox", { name: "Куда", exact: true }).selectOption("meet");
  await rule.getByRole("button", { name: "Выше", exact: true }).click();
  await panel.getByRole("button", { name: "Словами", exact: true }).click();
  const extra = panel.locator("[data-exit-card]").last();
  await extra.getByRole("button", { name: "Удалить условие", exact: true }).click();
  await rule.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath(`sdk076-common-${width}.png`) });
  await board.getByTitle("Есть несохранённые правки", { exact: true }).click();
  await expect(board.getByTitle("Сохранено", { exact: true })).toBeVisible();
  const after = (await getLeadMagnet(connection.db, id))!;
  expect(after.publishedSnapshotId).toBeNull();
  expect(after.draft.flow.layout["@any"]).toEqual(flow.layout["@any"]);
  expect(after.draft.flow.anyState.except).toEqual(["build", "meet"]);
  expect(after.draft.flow.anyState.exits).toEqual([
    { id: "common_help", when: { type: "judge", text: "Человек явно просит вернуться к идее" }, to: "meet" },
    flow.anyState.exits[0],
  ]);
  await boardOf(page, id);
  const reopened = await common(page, board);
  await expect(reopened.locator('[data-exit-card="common_help"]').getByRole("textbox", { name: "Когда", exact: true })).toHaveValue("Человек явно просит вернуться к идее");
});

test("SDK121: общие настройки скрывают тестовый чат, сохраняя его chatId", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { id } = await seed();
  const board = await boardOf(page, id);
  await board.getByRole("button", { name: "Тестовый чат", exact: true }).click();
  await expect(board.getByRole("paragraph").filter({ hasText: "Здравствуйте!" })).toBeVisible({ timeout: 60_000 });
  const before = await connection.pool.query("select chat_id from app.preview_conversations where lead_magnet_id=$1", [id]);
  expect(before.rows).toHaveLength(1);
  await common(page, board);
  await expect(board.getByRole("textbox", { name: "Сообщение", exact: true })).toBeHidden();
  await board.getByRole("button", { name: "Тестовый чат", exact: true }).click();
  await expect(board.getByRole("paragraph").filter({ hasText: "Здравствуйте!" })).toBeVisible();
  const after = await connection.pool.query("select chat_id from app.preview_conversations where lead_magnet_id=$1", [id]);
  expect(after.rows).toEqual(before.rows);
  await page.screenshot({ path: test.info().outputPath("sdk076-preserved-chat.png") });
});

test("SDK121: замечание открывает общие переходы и фокусирует правило", async ({ page }) => {
  test.setTimeout(180_000);
  const { id } = await seed();
  const board = await boardOf(page, id);
  const panel = await common(page, board);
  await panel.locator('[data-exit-card="common_help"]').getByRole("textbox", { name: "Когда", exact: true }).fill("");
  await board.getByRole("button", { name: "Скрыть панель «Сценарий»", exact: true }).click();
  await board.getByRole("button", { name: "Проверить граф" }).click();
  const checks = board.getByRole("region", { name: "Проверка", exact: true });
  await checks.getByRole("button").filter({ hasText: /условие|пуст/i }).first().click();
  const rule = board.locator('[data-exit-card="common_help"]');
  await expect(rule).toBeVisible();
  await expect(board.locator('[data-flow-exit-focus="common_help"]')).toBeFocused();
});

test("SDK121: readOnly позволяет просмотр общих правил без правок", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { id } = await seed();
  const board = await boardOf(page, id);
  const before = (await getLeadMagnet(connection.db, id))!;
  // Задерживаем только отправку конструктора в тестовом браузере: его busy включает штатный app readOnly.
  // FlowTestChat, панель и persistence работают настоящими компонентами/API на изолированной БД.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/constructor/**", async (route) => {
    if (route.request().method() === "POST") { await held; await route.abort(); }
    else await route.continue();
  });
  try {
    await page.getByRole("tab", { name: "Разговор", exact: true }).click();
    const constructor = page.getByRole("region", { name: "Конструктор", exact: true });
    const input = constructor.getByRole("textbox");
    await input.fill("Проверь сценарий"); await input.press("Enter");
    await page.getByRole("tab", { name: "Сценарий", exact: true }).click();
    await expect(board.getByText("Только просмотр")).toBeVisible();
    const panel = await common(page, board);
    await expect(panel.getByRole("textbox", { name: "Когда", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Знакомство", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Удалить условие", exact: true }).first()).toBeDisabled();
    expect(await getLeadMagnet(connection.db, id)).toEqual(before);
    await page.screenshot({ path: test.info().outputPath("sdk076-readonly.png") });
  } finally { release(); }
});
