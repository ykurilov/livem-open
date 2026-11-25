import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { createLeadMagnet, getLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";
import { openTab } from "./open-tab";

/** Снимки для отчёта, не эталоны: забираются с машины прогона вместе с `test-results`. */
const SHOTS = "test-results/returning-shots";
const hideDevIndicator = (page: Page) => page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

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

test("эксперт задаёт свой автоответ бота и выбирает «Начать заново» для вернувшихся после конца программы", async ({ page }) => {
  test.setTimeout(180_000);
  const { db } = connection;
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // Автоответ — в настройках бота
  const token = `fake-return${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот возврата ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_return${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  await page.goto(`/bots/${bot!.id}`);
  const autoreply = page.getByLabel("Текст автоответа");
  await expect(autoreply).toHaveValue("");
  await expect(autoreply).toHaveAttribute("placeholder", /Помощь по программе уже закончилась/);
  await autoreply.fill("Программа закончилась. Я прочитаю ваше сообщение и отвечу сам.");
  const autoreplyCard = page.getByTestId("autoreply-settings");
  await autoreplyCard.getByRole("button", { name: "Сохранить" }).click();
  await expect(autoreplyCard.getByText("Сохранено")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await db.select().from(bots).where(eq(bots.id, bot!.id)))[0]!.autoreplyText).toBe(
    "Программа закончилась. Я прочитаю ваше сообщение и отвечу сам.",
  );
  await page.reload();
  await expect(page.getByLabel("Текст автоответа")).toHaveValue("Программа закончилась. Я прочитаю ваше сообщение и отвечу сам.");
  await hideDevIndicator(page);
  await autoreplyCard.scrollIntoViewIfNeeded();
  await autoreplyCard.screenshot({ path: `${SHOTS}/returning-bot-autoreply.png`, animations: "disabled" });

  // «Если человек вернулся после конца» — в «Настройках» лидмагнита; новый лидмагнит продолжает разговор
  const lead = await createLeadMagnet(db, { name: `Возврат ${tag}` });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
  await page.goto(`/lead-magnets/${lead.id}`);
  const choice = page.getByRole("combobox", { name: "Если человек вернулся после конца" });
  await openTab(page, "Настройки", choice);
  await expect(choice).toHaveValue("continue");
  await choice.selectOption({ label: "Начать заново" });
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Сохранено" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await getLeadMagnet(db, lead.id))?.draft.returnAfterProgram).toBe("restart");
  await hideDevIndicator(page);
  await choice.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/returning-lead-magnet-setting.png`, animations: "disabled" });
});
