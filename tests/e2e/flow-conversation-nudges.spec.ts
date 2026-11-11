import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { editLeadMagnet, viewLeadMagnet, type ConstructorToolDependencies } from "../../src/modules/constructor/tools";
import { createLeadMagnet, getLeadMagnet } from "../../src/modules/lead-magnets";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

let connection: DatabaseConnection;
test.beforeAll(() => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
});
test.afterAll(async () => {
  await connection.close();
});
test.beforeEach(async ({ context }) => {
  const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
});

/** Касания всего разговора, как их записал конструктор: лидмагнит без «Дней и времени». */
async function seedWithConstructorNudges() {
  const lead = await createLeadMagnet(connection.db, { name: "Касания от конструктора" });
  // Конструктору нужна только база: чаты и «Проверка» здесь не участвуют
  const deps = { db: connection.db } as ConstructorToolDependencies;
  const { flow } = await viewLeadMagnet(deps, lead.id, { sections: ["flow"] });
  const nudges = { afterSilence: [{ amount: 2, unit: "h" }], dailyAt: ["11:30"], giveUpAfter: { amount: 5, unit: "d" } };
  const edited = await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: { ...(flow as object), nudges } }] });
  expect(edited).toMatchObject({ ok: true });
  return lead.id;
}

async function openBoard(page: Page, id: string): Promise<Locator> {
  await expect(async () => {
    await page.goto(`/lead-magnets/${id}`);
  }).toPass({ timeout: 60_000 });
  const tab = page.getByRole("tab", { name: "Сценарий" });
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  const board = page.getByRole("tabpanel", { name: "Сценарий" });
  await expect(board.getByRole("application")).toBeVisible({ timeout: 60_000 });
  await expect(board.getByText("Только просмотр")).toBeHidden({ timeout: 60_000 });
  return board;
}

/** Общие настройки сценария: панель «Сценарий», пока на доске ничего не выбрано. */
async function openOverview(board: Locator): Promise<Locator> {
  await board.getByRole("button", { name: "Показать панель «Сценарий»", exact: true }).click();
  const panel = board.getByRole("complementary");
  await expect(panel.getByText("Общее для всех этапов", { exact: true })).toBeVisible();
  return panel;
}

async function saveBoard(page: Page, board: Locator) {
  const isSave = (request: Request) => request.method() === "POST" && request.headers()["next-action"] !== undefined && (request.postData() ?? "").includes('"states"');
  const answered = page.waitForResponse((response) => isSave(response.request()), { timeout: 60_000 });
  await board.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect((await answered).ok()).toBe(true);
}

test("касания разговора от конструктора видны и правятся в общих настройках доски", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const id = await seedWithConstructorNudges();
  const board = await openBoard(page, id);
  const panel = await openOverview(board);

  // Раздел «Напоминания» доски SDK (0.104): виден и без «Дней и времени»
  const nudges = panel.getByRole("region", { name: "Напоминания", exact: true });
  await nudges.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("touches-overview.png") });

  await expect(nudges.getByRole("spinbutton", { name: "Молчит — написать через 1", exact: true })).toHaveValue("2");
  await expect(nudges.getByRole("textbox", { name: "Потом каждый день в 1", exact: true }).or(nudges.getByLabel("Потом каждый день в 1", { exact: true }))).toHaveValue("11:30");
  await expect(nudges.getByRole("spinbutton", { name: "Молчит столько — разговор окончен", exact: true })).toHaveValue("5");

  // Правка человека ложится в те же касания, по которым работает агент
  await nudges.getByRole("spinbutton", { name: "Молчит — написать через 1", exact: true }).fill("3");
  await saveBoard(page, board);
  await expect(board.getByRole("status").filter({ hasText: "Сохранено" })).toBeVisible();
  const { flow } = (await getLeadMagnet(connection.db, id))!.draft;
  expect(flow.nudges).toEqual({ afterSilence: [{ amount: 3, unit: "h" }], dailyAt: ["11:30"], giveUpAfter: { amount: 5, unit: "d" } });
  // Правка касаний не включает «Дни и время»
  expect(flow.schedule).toBeUndefined();
});
