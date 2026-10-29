import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { leadMagnetToFlow } from "../../src/modules/flows/settings-to-flow";
import { createLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import type { LeadMagnetSettings } from "../../src/modules/lead-magnets/settings";
import { createField, type FieldDefinition } from "../../src/modules/people";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

// Вкладка «Сценарий» отдаёт доске почти всё окно: меню — узкая полоса значков, шапка в одну строку, вокруг доски нет полей.
// SHOTS_DIR — папка для снимков и замера площади холста (сравнение «до/после»); без неё снимки не снимаются.
let connection: DatabaseConnection;

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

/** «Твоё первое приложение» в старом виде (этапы и программа): из него собирается сценарий, как при переводе на сценарии. */
const firstApp = JSON.parse(readFileSync("src/modules/flows/first-app.legacy.json", "utf8")) as {
  name: string;
  cardDescription: string;
  instruction: string;
  firstMessage: string;
  endCondition: string;
  farewellMessage: string;
  maxPersonMessages: number;
  viewsLinks: boolean;
  fields: Array<{ name: string; type: FieldDefinition["type"]; options?: string[]; description: string }>;
  stages: Array<{ name: string; instruction: string; transitionCondition: string; startDay: number | null; isSale: boolean }>;
  program: Omit<NonNullable<LeadMagnetSettings["program"]>, "sideTasks"> & { sideTasks: Array<{ task: string; field: string; when: string }> };
};

/** Многонодовый сценарий с днями и касаниями; поля создаются один раз на поток — имена у потоков разные. */
let firstAppFields: Promise<FieldDefinition[]> | undefined;
const ensureFirstAppFields = () =>
  (firstAppFields ??= Promise.all(firstApp.fields.map((field) => createField(connection.db, { ...field, name: `${field.name} ${randomUUID().slice(0, 8)}` }))));

async function seedFirstApp(tag: string) {
  const { db } = connection;
  const fields = await ensureFirstAppFields();
  const fieldId = (name: string) => fields[firstApp.fields.findIndex((field) => field.name === name)]!.id;
  const lead = await createLeadMagnet(db, { name: `Первое приложение ${tag}` });
  const { program } = firstApp;
  const settings: LeadMagnetSettings = {
    ...lead.draft,
    instruction: firstApp.instruction,
    firstMessage: firstApp.firstMessage,
    endCondition: firstApp.endCondition,
    farewellMessage: firstApp.farewellMessage,
    maxPersonMessages: firstApp.maxPersonMessages,
    viewsLinks: firstApp.viewsLinks,
    fieldIds: fields.map((field) => field.id),
    stages: firstApp.stages.map((stage, index) => ({ id: `stage-${index + 1}`, ...stage })),
    program: { ...program, sideTasks: program.sideTasks.map((task, index) => ({ id: `task-${index + 1}`, task: task.task, fieldId: fieldId(task.field), when: task.when })) },
  };
  await saveDraft(db, lead.id, { ...settings, flow: leadMagnetToFlow(settings, fields) }, "manual");
  return lead.id;
}

async function openBoard(page: Page, id: string) {
  await page.goto(`/lead-magnets/${id}`);
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

/** Узкая полоса меню «Студии»: только значки разделов, одинаковой ширины на всех вкладках. */
const NARROW_NAVIGATION_MAX_WIDTH = 80;
const navigation = (page: Page) => page.getByRole("navigation", { name: "Разделы кабинета" });
const navigationBox = async (page: Page) => (await navigation(page).boundingBox())!;
/** Панель «Рабочая область» отстоит от низа окна на рамку «Студии» (`--yk-space-4` под панелью), не больше. */
const STUDIO_FRAME_GAP = 16;
/** Верх холста: под шапкой «Студии» и компактной шапкой редактора, без полей страницы. */
const CANVAS_MAX_TOP = 185;
const workAreaBox = async (page: Page) => (await page.getByRole("region", { name: "Рабочая область" }).boundingBox())!;

const canvasBox = async (board: ReturnType<Page["getByRole"]>) => (await board.getByRole("application").boundingBox())!;
const canvasSize = (box: { width: number; height: number }) => `${Math.round(box.width)}×${Math.round(box.height)}`;

/** Размер холста, который не менялся 300 мс подряд. */
async function settledCanvasSize(board: ReturnType<Page["getByRole"]>): Promise<string> {
  let last = canvasSize(await canvasBox(board));
  let stableSince = Date.now();
  while (Date.now() - stableSince < 300) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const now = canvasSize(await canvasBox(board));
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    }
  }
  return last;
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`доска занимает окно ${size.width}×${size.height}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: "light" });
    const board = await openBoard(page, await seedFirstApp(`${size.width}`));
    // Доска перестраивается под окно: ждём, пока размер холста перестанет меняться
    await settledCanvasSize(board);

    const box = await canvasBox(board);
    const dir = process.env.SHOTS_DIR;
    if (dir) {
      await page.screenshot({ path: `${dir}/${size.width}x${size.height}.png` });
      console.log(`CANVAS ${size.width}x${size.height}: ${Math.round(box.width)}×${Math.round(box.height)} = ${Math.round(box.width * box.height)} px²`);
      // Панель этапа с напоминаниями: подписи из flowLabels
      await board.getByText(firstApp.stages[0]!.name, { exact: true }).first().click();
      await page.screenshot({ path: `${dir}/${size.width}x${size.height}-state.png` });
      await page.keyboard.press("Escape");
      await settledCanvasSize(board);
    }

    // Меню — узкая полоса со значками всех разделов, доска начинается сразу за ней
    await expect(navigation(page).getByRole("link", { name: "Настройки", exact: true })).toBeVisible();
    const nav = await navigationBox(page);
    expect(nav.width).toBeLessThanOrEqual(NARROW_NAVIGATION_MAX_WIDTH);
    expect(box.x - (nav.x + nav.width)).toBeLessThan(32);
    // Внутри рабочей области у доски нет полей: холст доходит до её низа, а под ней только рамка «Студии»
    const workArea = await workAreaBox(page);
    expect(workArea.y + workArea.height - (box.y + box.height)).toBeLessThan(4);
    expect(size.height - (workArea.y + workArea.height)).toBeLessThanOrEqual(STUDIO_FRAME_GAP);
    // Сверху только шапка «Студии» и компактная шапка редактора (как в first-app-simplified); по ширине граф рядом с правой панелью доски — больше половины окна
    expect(box.y).toBeLessThan(CANVAS_MAX_TOP);
    expect(box.width).toBeGreaterThan(size.width * 0.55);
  });
}

test("меню одной ширины на всех вкладках: «Сценарий» его не прячет, доска после возврата той же площади", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await openBoard(page, await seedFirstApp("меню"));
  const onBoard = await navigationBox(page);
  const canvas = await settledCanvasSize(board);
  expect(onBoard.width).toBeLessThanOrEqual(NARROW_NAVIGATION_MAX_WIDTH);

  await page.getByRole("tab", { name: "Настройки" }).click();
  await expect(page.getByRole("tab", { name: "Настройки" })).toHaveAttribute("aria-selected", "true");
  expect((await navigationBox(page)).width).toBe(onBoard.width);
  await expect(navigation(page).getByRole("link", { name: "Настройки", exact: true })).toBeVisible();

  // Другая вкладка и обратно: ни меню, ни доска не меняют размер
  await page.getByRole("tab", { name: "Сценарий" }).click();
  await expect(board.getByRole("application")).toBeVisible();
  expect((await navigationBox(page)).width).toBe(onBoard.width);
  expect(await settledCanvasSize(board)).toBe(canvas);
});

test("на телефоне 390 px вкладка «Сценарий» не ломает страницу", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const board = await openBoard(page, await seedFirstApp("телефон"));
  await expect(board.getByRole("application")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await canvasBox(board);
  expect(box.width).toBeGreaterThan(300);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/390x844.png` });
});
