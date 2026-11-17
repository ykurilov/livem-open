import { expect, test, type BrowserContext } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { createLeadMagnet, publishWithBots, saveDraft, unpublishLeadMagnet } from "../../src/modules/lead-magnets";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";

const SHOTS = process.env.WEBONLY_SHOTS_DIR;
const START_OVER = "Начать разговор заново";

let connection: DatabaseConnection;

test.beforeAll(() => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
});

test.afterAll(async () => {
  await connection.close();
});

async function signInExpert(context: BrowserContext): Promise<void> {
  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
}

test("публикация без бота → веб-страница → разговор → «Начать разговор заново» у автора даёт чистый старт; посторонним кнопки нет", async ({ browser, page }) => {
  test.setTimeout(180_000);
  const { db } = connection;
  const tag = Date.now().toString(36);
  const lead = await createLeadMagnet(db, { name: `Только веб ${tag}` });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");

  await signInExpert(page.context());

  // Эксперт публикует, не выбирая ботов: работает веб-страница
  await page.goto(`/lead-magnets/${lead.id}/publish`);
  await expect(page.getByText("Без бота лидмагнит заработает только на веб-странице")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(page.getByText("Опубликовано", { exact: true })).toBeVisible({ timeout: 30_000 });
  const webLink = page.getByTestId("entry-link-web");
  await expect(webLink).toContainText("/c/", { timeout: 30_000 });
  await expect(page.getByTestId(/^entry-link-(telegram|vk|max)$/)).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/webonly-publish.png`, fullPage: true });
  const path = new URL(await webLink.innerText()).pathname;

  // Посторонний посетитель: разговор есть, кнопки сброса нет, и сервер его запрос отклоняет
  const strangerContext = await browser.newContext();
  const stranger = await strangerContext.newPage();
  await stranger.goto(path);
  await expect(stranger.getByRole("log", { name: "Переписка" }).getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  await expect(stranger.getByRole("button", { name: START_OVER })).toHaveCount(0);
  const refused = await strangerContext.request.post("/api/web-chat-owner/start-over", { data: { code: path.split("/").at(-1) } });
  expect([401, 403]).toContain(refused.status());
  await strangerContext.close();

  // Автор на живой странице: говорит, потом начинает заново — как новый посетитель
  await page.goto(path);
  const feed = page.getByRole("log", { name: "Переписка" });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  const said = `Я веду курсы ${tag}`;
  await page.getByRole("textbox", { name: "Сообщение" }).fill(said);
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(feed.getByText(said)).toBeVisible();
  await expect(feed.getByText(E2E_SCRIPT.consultantReply)).toBeVisible({ timeout: 30_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/webonly-start-over-button.png` });

  const startOverResponse = page.waitForResponse((response) => response.url().endsWith("/api/web-chat-owner/start-over"));
  await page.getByRole("button", { name: START_OVER }).click();
  const answered = await startOverResponse;
  expect(answered.status()).toBe(200);
  await page.waitForURL(path);
  await expect(feed.getByText(said)).toHaveCount(0, { timeout: 30_000 });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toHaveCount(1, { timeout: 30_000 });
  await expect(feed.getByText(E2E_SCRIPT.consultantReply)).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/webonly-after-start-over.png` });

  // Снят с публикации: новый разговор не начнётся — и кнопки нет
  await unpublishLeadMagnet(db, lead.id);
  await page.reload();
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: START_OVER })).toHaveCount(0);
});

test("боты были, а публикация снимает всех — только с явным согласием", async ({ page }) => {
  const { db } = connection;
  const tag = Date.now().toString(36);
  const lead = await createLeadMagnet(db, { name: `Были боты ${tag}` });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
  const token = `fake-webonly${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_webonly${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  await publishWithBots(db, lead.id, { telegram: bot!.id });
  await signInExpert(page.context());

  await page.goto(`/lead-magnets/${lead.id}/publish`);
  await page.getByRole("combobox", { name: "Бот Telegram" }).selectOption("none");
  await expect(page.getByText("Ссылки в мессенджерах перестанут работать")).toBeVisible({ timeout: 30_000 });
  const publish = page.getByRole("button", { name: "Опубликовать снова", exact: true });
  await expect(publish).toBeDisabled();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/webonly-confirm.png` });
  await page.getByText("Да, публиковать только веб-страницу").click();
  await publish.click();
  await expect(page.getByText("Опубликовано", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("entry-link-telegram")).toHaveCount(0);
  await expect(page.getByTestId("entry-link-web")).toContainText("/c/");
});
