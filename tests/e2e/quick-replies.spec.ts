import { expect, test, type Page } from "@playwright/test";
import { bots } from "../../src/modules/channels/schema";
import { createLabeledLink, createLeadMagnet, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { seal } from "../../src/auth/core/cookie-seal";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";
import { openTab } from "./open-tab";

let connection: DatabaseConnection;

test.beforeAll(() => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
});

test.afterAll(async () => {
  await connection.close();
});

/** Опубликованный лидмагнит со своим тестовым ботом Telegram (без мессенджера не публикуется); адрес веб-чата. */
async function publishedChatPath(tag: string): Promise<string> {
  const { db } = connection;
  const lead = await createLeadMagnet(db, { name: `Кнопки ${tag}` });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
  const token = `fake-qr${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот кнопок ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_qr${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  await publishWithBots(db, lead.id, { telegram: bot!.id });
  const link = await createLabeledLink(db, { leadMagnetId: lead.id, label: `Кнопки ${tag}` });
  return `/c/${link.code}`;
}

async function askForOptions(chat: Page) {
  await chat.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  const feed = chat.getByRole("log", { name: "Переписка" });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  await chat.getByRole("textbox", { name: "Сообщение" }).fill(`Какие есть ${E2E_SCRIPT.quickRepliesTrigger}?`);
  await chat.getByRole("button", { name: "Отправить" }).click();
  await expect(feed.getByText(E2E_SCRIPT.quickRepliesQuestion)).toBeVisible({ timeout: 30_000 });
  const buttons = chat.getByRole("group", { name: "Быстрые ответы" });
  await expect(buttons.getByRole("button")).toHaveText([...E2E_SCRIPT.quickReplies]);
  await expect(feed.getByText(E2E_SCRIPT.quickRepliesAfterthought)).toHaveCount(0);
  return { feed, buttons };
}

test("кнопки готовых ответов: нажатие отправляет текст сообщением, после ответа кнопки пропадают", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(await publishedChatPath(Date.now().toString(36)));
  const { feed, buttons } = await askForOptions(page);

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: `test-results/qr-${colorScheme}.png`, animations: "disabled", caret: "hide" });
  }
  await page.emulateMedia({ colorScheme: "light" });

  const chosen = E2E_SCRIPT.quickReplies[0];
  await buttons.getByRole("button", { name: chosen }).click();
  await expect(feed.getByText(chosen)).toBeVisible();
  await expect(buttons).toHaveCount(0);
  await expect(feed.getByText(E2E_SCRIPT.consultantReply)).toBeVisible({ timeout: 30_000 });
  await expect(buttons).toHaveCount(0);
});

test("кнопки на телефоне: переносятся, не вылезают за экран, удобны пальцу", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
  const chat = await context.newPage();
  await chat.goto(await publishedChatPath(`m${Date.now().toString(36)}`));
  const { buttons } = await askForOptions(chat);

  for (const button of await buttons.getByRole("button").all()) {
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  }
  await chat.screenshot({ path: "test-results/qr-phone.png", animations: "disabled", caret: "hide" });
  await context.close();
});

test("«Проверка»: вопрос с кнопками остаётся на месте, дописка после кнопок не появляется", async ({ page, context }) => {
  test.setTimeout(120_000);
  const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
  const lead = await createLeadMagnet(connection.db, { name: "Кнопки в «Проверке»" });
  await saveDraft(connection.db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");

  await page.goto(`/lead-magnets/${lead.id}`);
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await openTab(page, "Разговор");
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  const input = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(async () => {
    await input.fill(`Какие есть ${E2E_SCRIPT.quickRepliesTrigger}?`);
    await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await input.press("Enter");
  // Текст ответа ещё и в скрытой строке для экранного диктора: берём видимый абзац
  const question = preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.quickRepliesQuestion });

  await expect(question).toBeVisible({ timeout: 30_000 });
  // Дописка пришла бы после кнопок тем же ходом: проверяем, когда ход закончен
  await expect(preview.getByRole("button", { name: "Остановить", exact: true })).toBeHidden({ timeout: 30_000 });
  for (const reply of E2E_SCRIPT.quickReplies) await expect(preview.getByRole("button", { name: reply, exact: true })).toBeVisible();
  await expect(question).toBeVisible();
  await expect(preview.getByText(E2E_SCRIPT.quickRepliesAfterthought)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("vanish-preview.png"), animations: "disabled", caret: "hide" });

  await page.reload();
  await openTab(page, "Разговор");
  await expect(question).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByText(E2E_SCRIPT.quickRepliesAfterthought)).toHaveCount(0);
});
