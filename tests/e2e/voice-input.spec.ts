import { expect, test, type Page } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { createLabeledLink, createLeadMagnet, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";
import { FAKE_SONIOX_PHRASE } from "./fake-soniox";
import { openTab } from "./open-tab";

// Микрофон подменён: браузер сам разрешает доступ и пишет искусственный звук, Soniox — подставной (start-server.ts)
test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  permissions: ["microphone"],
});

/** Снимки для отчёта, не эталоны: забираются с машины прогона вместе с `test-results`. */
const SHOTS = "test-results/voice-shots";
const hideDevIndicator = (page: Page) => page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

let connection: DatabaseConnection;

test.beforeAll(() => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
});

test.afterAll(async () => {
  await connection.close();
});

/** Опубликованный лидмагнит с веб-ссылкой; `voiceInput` — переключатель «Голосовой ввод». */
async function publishedWebChat(tag: string, voiceInput: boolean): Promise<string> {
  const { db } = connection;
  const lead = await createLeadMagnet(db, { name: `Голос ${tag}` });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage, voiceInput }, "manual");
  const token = `fake-voice${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот голоса ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_voice${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  await publishWithBots(db, lead.id, { telegram: bot!.id });
  const link = await createLabeledLink(db, { leadMagnetId: lead.id, label: `Метка ${tag}` });
  return `/c/${link.code}`;
}

test("веб-чат: микрофон в поле дописывает сказанное к набранному, текст уходит обычным сообщением; без «Голосового ввода» микрофона нет", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const tag = Date.now().toString(36);
  const [withVoice, withoutVoice] = await Promise.all([publishedWebChat(`${tag}a`, true), publishedWebChat(`${tag}b`, false)]);

  await page.goto(withVoice);
  const feed = page.getByRole("log", { name: "Переписка" });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  const input = page.getByRole("textbox", { name: "Сообщение" });
  await expect(input).toBeEnabled();
  await input.fill("Здравствуйте!");

  await page.getByRole("button", { name: "Диктовать" }).click();
  await expect(input).toHaveValue(`Здравствуйте! ${FAKE_SONIOX_PHRASE}`, { timeout: 15_000 });
  await page.getByRole("button", { name: "Остановить диктовку" }).click();
  await expect(page.getByRole("button", { name: "Диктовать" })).toBeVisible({ timeout: 15_000 });
  // Надиктованное можно поправить перед отправкой
  await input.fill(`${await input.inputValue()} завтра`);
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(feed.getByText(`Здравствуйте! ${FAKE_SONIOX_PHRASE} завтра`)).toBeVisible({ timeout: 15_000 });
  await expect(input).toHaveValue("");

  // Снимки поля для отчёта: светлая и тёмная тема, телефон. Тема выбирается при загрузке страницы — у каждого своё окно
  const shots = [
    { name: "light", options: { colorScheme: "light" as const } },
    { name: "dark", options: { colorScheme: "dark" as const } },
    { name: "phone", options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ];
  for (const shot of shots) {
    const shotContext = await browser.newContext({ ...shot.options, reducedMotion: "reduce", permissions: ["microphone"] });
    const shotPage = await shotContext.newPage();
    await shotPage.goto(withVoice);
    await expect(shotPage.getByRole("button", { name: "Диктовать" })).toBeEnabled({ timeout: 30_000 });
    await shotPage.getByRole("textbox", { name: "Сообщение" }).fill("Можно вопрос про запись?");
    await hideDevIndicator(shotPage);
    await shotPage.screenshot({ path: `${SHOTS}/web-chat-voice-${shot.name}.png` });
    await shotContext.close();
  }

  await page.goto(withoutVoice);
  await expect(page.getByRole("textbox", { name: "Сообщение" })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Отправить" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Диктовать" })).toHaveCount(0);
});

test("«Проверка»: при включённом «Голосовом вводе» микрофон есть и в поле тестового чата", async ({ page, context }) => {
  test.setTimeout(120_000);
  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
  const lead = await createLeadMagnet(connection.db, { name: "Голос в «Проверке»" });
  await saveDraft(connection.db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: "Здравствуйте!", voiceInput: true }, "manual");

  await page.goto(`/lead-magnets/${lead.id}`);
  await openTab(page, "Разговор");
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  const input = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(input).toBeVisible({ timeout: 30_000 });
  await preview.getByRole("button", { name: "Диктовать" }).click();
  await expect(input).toHaveValue(FAKE_SONIOX_PHRASE, { timeout: 15_000 });
  await preview.getByRole("button", { name: "Остановить диктовку" }).click();
  await expect(preview.getByRole("button", { name: "Диктовать" })).toBeVisible({ timeout: 15_000 });
  await hideDevIndicator(page);
  await page.screenshot({ path: `${SHOTS}/preview-voice.png` });
});
