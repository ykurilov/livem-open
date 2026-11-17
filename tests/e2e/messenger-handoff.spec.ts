import { expect, test, type Locator, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots, outboundMessages } from "../../src/modules/channels/schema";
import { createLeadMagnet, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
import { people } from "../../src/modules/people/schema";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv, FRESH_CONNECTION } from "./e2e-env";
import { openTab } from "./open-tab";

let connection: DatabaseConnection;

test.beforeAll(() => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
});

test.afterAll(async () => {
  await connection.close();
});

// Снимки — только по просьбе (`SHOTS_DIR=…`): запись в папку проекта перезагружает страницы `next dev`
const SHOTS_DIR = process.env.SHOTS_DIR;
const WITHOUT_DEV_INDICATOR = "nextjs-portal { display: none !important; }";
const saveShot = async (target: Page | Locator, name: string) => {
  if (SHOTS_DIR) await target.screenshot({ path: `${SHOTS_DIR}/${name}`, style: WITHOUT_DEV_INDICATOR });
};
/** Снимок веб-чата на ширине телефона; нажатия — в обычной ширине, там значок Next.js не закрывает кнопки. */
const phoneShot = async (chat: Page, name: string) => {
  if (!SHOTS_DIR) return;
  const size = chat.viewportSize();
  await chat.setViewportSize({ width: 390, height: 844 });
  await saveShot(chat, name);
  if (size) await chat.setViewportSize(size);
};

test("из веб-чата в мессенджер: настройка, кнопки в «Проверке» и в веб-чате, «Старт» в боте — разговор продолжается там", async ({ browser, page, request }) => {
  test.setTimeout(240_000);
  const { db } = connection;
  const tag = Date.now().toString(36);

  const lead = await createLeadMagnet(db, { name: `Переход ${tag}` });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
  const token = `fake-handoff${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот перехода ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_handoff${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  const [vkBot] = await db
    .insert(bots)
    .values({
      channel: "vk",
      title: `Сообщество перехода ${tag}`,
      externalId: String(Math.floor(Math.random() * 1e9)),
      username: `club_handoff${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(`fake-vk-handoff${tag}`),
      webhookSecret: `secret-vk-${tag}`,
    })
    .returning();

  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await page.context().addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);

  // Эксперт включает переход в «Настройках»
  await page.goto(`/lead-magnets/${lead.id}`);
  await openTab(page, "Настройки");
  const block = page.getByTestId("messenger-handoff-settings");
  await block.getByRole("checkbox", { name: "Звать из веб-чата в мессенджер" }).check();
  await block.getByLabel("Когда предложить").fill("Когда человек согласился продолжить в мессенджере");
  await block.getByRole("checkbox", { name: "Max" }).uncheck();
  await block.scrollIntoViewIfNeeded();
  await saveShot(block, "handoff-settings.png");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible({ timeout: 30_000 });

  // «Проверка»: консультант показал кнопки выбранных мессенджеров, нажатие изображает «Старт»
  await openTab(page, "Разговор");
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  const previewInput = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(async () => {
    await previewInput.fill("Давайте продолжим в мессенджер");
    await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await previewInput.press("Enter");
  const previewButtons = preview.getByTestId("preview-messenger-handoff");
  await expect(previewButtons.getByRole("button", { name: "Открыть ВКонтакте" })).toBeVisible({ timeout: 60_000 });
  await saveShot(page, "handoff-preview-buttons.png");
  await previewButtons.getByRole("button", { name: "Открыть Telegram" }).click();
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.handoffContinuation })).toBeVisible({ timeout: 60_000 });
  await expect(previewButtons).toContainText("Разговор перешёл в Telegram");

  // Лидмагнит опубликован в Telegram и ВКонтакте: в веб-чате две кнопки
  await publishWithBots(db, lead.id, { telegram: bot!.id, vk: vkBot!.id });
  await page.goto(`/lead-magnets/${lead.id}/publish`);
  await expect(page.getByTestId("entry-link-web")).toContainText("/c/", { timeout: 30_000 });
  const webUrl = await page.getByTestId("entry-link-web").innerText();

  const visitor = await browser.newContext();
  const chat = await visitor.newPage();
  await chat.goto(new URL(webUrl).pathname);
  const feed = chat.getByRole("log", { name: "Переписка" });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  const input = chat.getByRole("textbox", { name: "Сообщение" });
  await input.fill("Давайте продолжим в мессенджер");
  await chat.getByRole("button", { name: "Отправить" }).click();

  const offer = chat.getByRole("group", { name: "Продолжение в мессенджере" });
  const telegram = offer.getByRole("link", { name: "Открыть Telegram" });
  await expect(telegram).toBeVisible({ timeout: 60_000 });
  const vk = offer.getByRole("link", { name: "Открыть ВКонтакте" });
  await expect(offer.getByRole("link")).toHaveCount(2);
  // Подделка ВКонтакте строит ссылку как подделка Telegram: в ней бот ВКонтакте и тот же код перехода
  await expect(vk).toHaveAttribute("href", new RegExp(`^https://fake\\.test/${vkBot!.username}\\?start=[A-Za-z0-9]{24}$`));
  // Обе — в одну строку, со знаками мессенджеров
  const [telegramBox, vkBox] = await Promise.all([telegram.boundingBox(), vk.boundingBox()]);
  expect(Math.abs(telegramBox!.y - vkBox!.y)).toBeLessThan(2);
  await expect(offer.locator("svg")).toHaveCount(2);
  await expect(feed.getByText(E2E_SCRIPT.handoffReply)).toBeVisible();
  // Поле ввода закрыто: человек может только нажать кнопку
  await expect(input).toHaveCount(0);
  await phoneShot(chat, "handoff-webchat-buttons.png");

  const href = (await telegram.getAttribute("href"))!;
  expect(href).toContain(`https://fake.test/${bot!.username}?start=`);
  const startCode = new URL(href).searchParams.get("start")!;
  expect(startCode).toMatch(/^[A-Za-z0-9]{24}$/);

  // Человек нажал «Старт» в боте: тот же разговор, агент пишет первым без знакомства
  const userId = `tg-${tag}`;
  const response = await request.post(`/api/webhooks/telegram/${bot!.id}`, {
    headers: { ...FRESH_CONNECTION, "x-fake-secret": bot!.webhookSecret },
    data: { events: [{ type: "message", dedupeKey: `e2e:${tag}:start`, userId, userName: "Егор", text: `/start ${startCode}`, startCode }] },
  });
  expect(response.status()).toBe(200);
  await expect
    .poll(
      async () => {
        const [person] = await db.select().from(people).where(and(eq(people.botId, bot!.id), eq(people.externalUserId, userId)));
        if (!person) return [];
        const rows = await db.select().from(outboundMessages).where(and(eq(outboundMessages.personId, person.id), eq(outboundMessages.status, "sent")));
        return rows.map((row) => row.text);
      },
      { timeout: 60_000 },
    )
    .toContain(E2E_SCRIPT.handoffContinuation);

  // Веб-чат показывает, где продолжается разговор
  const moved = chat.getByRole("group", { name: "Продолжение в мессенджере" });
  await expect(moved).toContainText("Разговор продолжается в Telegram", { timeout: 30_000 });
  await expect(moved.getByRole("link", { name: "Перейти в Telegram" })).toHaveAttribute("href", /fake\.test/);
  await phoneShot(chat, "handoff-webchat-after.png");
  await visitor.close();
});
