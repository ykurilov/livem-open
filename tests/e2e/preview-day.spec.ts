import { expect, test, type Page } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { leadMagnetToFlow } from "../../src/modules/flows/settings-to-flow";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { createLeadMagnet, getLeadMagnet, newProgramSettings, saveDraft } from "../../src/modules/lead-magnets";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { timeZoneAtHour } from "../time-zone-at-hour";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

// Дни программы — по поясу эксперта, а вечером первым днём считается завтра: браузер — там, где сейчас полдень
test.use({ timezoneId: timeZoneAtHour(12) });

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

const stage = (id: string, name: string, startDay: number | null = null) => ({ id, name, instruction: "Веди разговор", transitionCondition: "Готово", startDay, isSale: false });

async function seedLead(name: string, withProgram: boolean) {
  const lead = await createLeadMagnet(connection.db, { name });
  const settings = {
    ...lead.draft,
    instruction: "Ты консультант.",
    firstMessage: "Здравствуйте!",
    stages: withProgram ? [stage("s-meet", "Знакомство"), stage("s-offer", "Предложение", 2)] : [stage("s-meet", "Знакомство")],
    program: withProgram ? newProgramSettings(3) : null,
  };
  // Этапы и программа — сценарием, как после перевода настроек
  // Судья в подставной модели соглашается со всем, а проверке нужен только переход по сроку: переходы «по смыслу» убраны
  const flow = leadMagnetToFlow(settings, []);
  // Срок «нода длится 1 день» перевод этапов больше не ставит (ноды дня N — по результату) — здесь он задан, как на доске
  const dayTimer = { id: "s-meet_days", when: { type: "timer" as const, from: "state_days" as const, days: 1 }, to: "s-offer" };
  const withoutJudge = {
    ...flow,
    states: flow.states.map((state) => {
      const exits = state.exits.filter((exit) => exit.when.type !== "judge");
      return { ...state, exits: withProgram && state.id === "s-meet" ? [...exits, dayTimer] : exits };
    }),
  };
  await saveDraft(connection.db, lead.id, { ...settings, flow: withoutJudge }, "manual");
  return lead.id;
}

// Снимки для спецификации — только по просьбе (`SHOTS_DIR=… pnpm test:e2e`): запись файла в папку проекта перезагружает страницы `next dev` в соседних тестах
const SHOTS_DIR = process.env.SHOTS_DIR;
const saveShot = async (page: Page, name: string) => {
  if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/${name}` });
};

test("«Проверка» программы: подпись дня, «К началу следующего дня» и до первого сообщения приносит утреннее", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await seedLead("Программа с днями (проверка)", true);
  await page.goto(`/lead-magnets/${id}`);
  await page.getByRole("tab", { name: "Разговор" }).click();
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  await expect(preview.getByText("День 1 из 3 · Знакомство")).toBeVisible({ timeout: 60_000 });

  // Тестовый чат за сценарием с начала: перемотка работает и до первого сообщения эксперта
  const nextDay = preview.getByRole("button", { name: "К началу следующего дня" });
  await expect(nextDay).toBeEnabled();
  await nextDay.click();
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.morningReply })).toBeVisible({ timeout: 60_000 });
  await expect(preview.getByText(/День 2 из 3 · /)).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await saveShot(page, "s7-preview-day-1280.png");

  // «Лог» объясняет, почему бот перешёл в другую ноду и почему написал первым
  await page.getByRole("tab", { name: "Лог" }).click();
  const log = page.getByRole("tabpanel", { name: "Лог" });
  const transition = log.getByTestId("log-transition").first();
  await expect(transition).toContainText("Переход: Знакомство → Предложение", { timeout: 15_000 });
  await expect(transition).toContainText("Решил: таймер");
  await expect(transition).toContainText("День 2 из 3");
  const firstMessage = log.getByTestId("log-first-message").first();
  await expect(firstMessage).toContainText("Почему бот написал первым");
  await expect(firstMessage).toContainText("Утреннее сообщение нового дня");
  await saveShot(page, "s7-log-transition-1280.png");

  // Телефон открывает страницу с нуля: так узкая вёрстка строится как у человека
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("tab", { name: "Разговор" }).click();
  await expect(preview.getByText(/День 2 из 3 · /)).toBeVisible({ timeout: 60_000 });
  await expect(preview.getByRole("button", { name: "К началу следующего дня" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("доска: тестовый чат — тот же разговор «Проверки», «К началу следующего дня» работает и там", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await seedLead("Доска с тестовым чатом", true);
  await page.goto(`/lead-magnets/${id}`);
  const tab = page.getByRole("tab", { name: "Сценарий" });
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  const board = page.getByRole("tabpanel", { name: "Сценарий" });
  await board.getByRole("button", { name: "Тестовый чат" }).click();

  await expect(board.getByRole("paragraph").filter({ hasText: "Здравствуйте!" })).toBeVisible({ timeout: 60_000 });
  const input = board.getByRole("textbox", { name: "Сообщение" });
  await input.fill("Я коуч");
  await expect(input.locator("xpath=ancestor::*[@role='tabpanel'][1]").getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  await input.press("Enter");
  await expect(board.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.consultantReply })).toBeVisible({ timeout: 30_000 });

  await expect(board.getByRole("button", { name: "К началу следующего дня" })).toBeEnabled({ timeout: 30_000 });
  await board.getByRole("button", { name: "К началу следующего дня" }).click();
  await expect(board.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.morningReply })).toBeVisible({ timeout: 60_000 });
  // Подпись дня доска перечитывает отдельным запросом после хода
  await expect(board.getByText(/День 2 из 3/)).toBeVisible({ timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  await saveShot(page, "s7-board-test-chat-1280.png");
});

test("лидмагнит без программы: подписи дня и кнопки нет", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await seedLead("Без программы (проверка)", false);
  await page.goto(`/lead-magnets/${id}`);
  await page.getByRole("tab", { name: "Разговор" }).click();
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  await expect(preview.getByText("Этап: Знакомство")).toBeVisible({ timeout: 60_000 });
  await expect(preview.getByText(/День \d/)).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "К началу следующего дня" })).toHaveCount(0);
});

test("«+15 мин» в «Проверке»: клиент замолчал на 15 минут — агент пишет первым, касанием", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await seedLead("Касание через 15 минут", false);
  const lead = await getLeadMagnet(connection.db, id);
  const settings = lead!.draft;
  await saveDraft(connection.db, id, { ...settings, flow: { ...settings.flow, nudges: { afterSilence: [{ amount: 15, unit: "min" }, { amount: 1, unit: "h" }] } } }, "manual");

  await page.goto(`/lead-magnets/${id}`);
  await page.getByRole("tab", { name: "Разговор" }).click();
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  await expect(preview.getByText("Этап: Знакомство")).toBeVisible({ timeout: 60_000 });

  const input = preview.getByRole("textbox", { name: "Сообщение" });
  await input.fill("Я коуч");
  await expect(input.locator("xpath=ancestor::*[@role='tabpanel'][1]").getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  await input.press("Enter");
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.consultantReply })).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.morningReply })).toHaveCount(0);

  // Клиент молчит 15 минут: касание приходит в ленту после обновления страницы
  await preview.getByRole("button", { name: "+15 мин" }).click();
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.morningReply })).toBeVisible({ timeout: 60_000 });
  // Перед касанием серая строка объясняет, почему агент заговорил первым
  await expect(preview.getByText(/Агент написал первым/).first()).toBeVisible();

  // Ещё раз без подбора времени: «К следующему напоминанию» подводит часы к следующему касанию
  const before = await preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.morningReply }).count();
  await preview.getByRole("button", { name: "К следующему напоминанию" }).click();
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.morningReply })).toHaveCount(before + 1, { timeout: 60_000 });

  // Телефон: ряд кнопок и поле не ломают вёрстку
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("tab", { name: "Разговор" }).click();
  await expect(preview.getByRole("button", { name: "+3 ч" })).toBeVisible({ timeout: 60_000 });
  await expect(preview.getByRole("textbox", { name: "Промотать на своё время" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  // Непонятное время — подсказка, ничего не двигается
  await preview.getByRole("textbox", { name: "Промотать на своё время" }).fill("скоро");
  await preview.getByRole("button", { name: "Промотать" }).click();
  await expect(preview.getByRole("alert")).toContainText("45 мин");
});
