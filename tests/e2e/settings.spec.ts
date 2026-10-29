import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { openChatStorage } from "../../src/modules/platform/chat-storage";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { STUB_MODEL_CHOICE } from "../../src/modules/platform/models-catalog";
import { readSettings, updateSettings, type AppSettings } from "../../src/modules/platform/settings";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

// Тот же адрес политики, что у соседнего теста публикации: настройки в базе общие
const POLICY_URL = "https://example.com/privacy";
// Расход месяца — полтора бюджета: тревога 100% настоящая, а до аварийной остановки (200%) соседний разговор не дойдёт
const BUDGET_USD = 1;
const SPENT_USD = 1.5;

let connection: DatabaseConnection;
let before: AppSettings;
const usageRecordId = randomUUID();

test.beforeAll(async () => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
  before = await readSettings(connection.db);
  const chatStorage = await openChatStorage(e2eDatabaseUrl());
  try {
    await chatStorage.insertUsageRecord({
      id: usageRecordId,
      ownerId: `e2e-settings-${usageRecordId}`,
      chatId: randomUUID(),
      messageId: null,
      source: "answer",
      ...STUB_MODEL_CHOICE,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: SPENT_USD,
      createdAt: new Date().toISOString(),
    });
  } finally {
    await chatStorage.close();
  }
});

test.afterAll(async () => {
  const { db } = connection;
  // Адрес политики не возвращаем: его же ставит соседний тест публикации
  await updateSettings(db, {
    dailyLimitUsd: before.dailyLimitUsd,
    monthlyBudgetUsd: before.monthlyBudgetUsd,
    alertChatId: before.alertChatId,
  });
  await db.execute(sql`delete from agent_chat.usage_records where id = ${usageRecordId}`);
  await db.execute(sql`delete from app.alerts where kind like 'budget_%'`);
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

test("эксперт задаёт лимит и бюджет, видит превышение и гасит повтор тревоги кнопкой «Вижу»", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Дневной лимит на человека, $").fill("5");
  await page.getByLabel("Месячный бюджет, $").fill(String(BUDGET_USD));
  await page.getByLabel("Ссылка на политику обработки персональных данных").fill(POLICY_URL);
  await page.getByLabel("Куда слать тревоги").fill("-1001234567890");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
  expect(await readSettings(connection.db)).toMatchObject({
    dailyLimitUsd: "5.000000",
    monthlyBudgetUsd: "1.000000",
    alertChatId: "-1001234567890",
  });

  // Сохранение проверило бюджет: расход выше 100%, тревога ушла и повторяется раз в час — на экране «Вижу»
  await expect(page.getByTestId("month-spending")).toContainText("из $1.00");
  await page.getByRole("button", { name: "Вижу" }).click();
  await expect(page.getByRole("button", { name: "Вижу" })).toBeHidden();
});
