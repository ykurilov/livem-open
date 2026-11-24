import { expect, test, type Locator, type Page } from "@playwright/test";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { callBookings, callNotices } from "../../src/modules/booking/schema";
import { bots, outboundMessages } from "../../src/modules/channels/schema";
import { createLeadMagnet, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
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

const MEETING_LINK = "https://meet.test/e2e-call";

test("запись на созвон: окно в календаре, настройка, тестовая запись в «Проверке», живая запись — в «Записях» и в боте эксперта", async ({ browser, page, request }) => {
  test.setTimeout(240_000);
  const { db, pool } = connection;
  const tag = Date.now().toString(36);

  // Календарь один на аккаунт: только этот тест его трогает
  await pool.query("delete from app.call_notices; delete from app.call_notify_bots; delete from app.call_bookings; delete from app.call_windows; delete from app.call_calendar");

  const leadName = `Созвон ${tag}`;
  const lead = await createLeadMagnet(db, { name: leadName });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
  const token = `fake-calls${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот созвонов ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_calls${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();

  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await page.context().addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);

  // «Календарь»: окно в понедельник следующей недели — оно точно в будущем
  await page.goto("/calls");
  await expect(page.getByRole("heading", { name: "Созвоны" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("navigation", { name: "Недели" }).getByRole("link", { name: "Позже →" }).click();
  await expect(page).toHaveURL(/week=\d{4}-\d{2}-\d{2}/);
  // Адрес меняется раньше, чем приходит новая неделя: ждём её понедельник, иначе окно откроется на старой странице
  const monday = page.getByTestId(`call-day-${new URL(page.url()).searchParams.get("week")}`);
  await expect(monday).toBeVisible({ timeout: 30_000 });
  const windowDialog = page.getByRole("dialog", { name: "Новое окно для созвонов" });
  // Пока страница не ожила, кнопка выключена: нажатие не пропадёт молча
  const addWindow = monday.getByRole("button", { name: "Добавить окно" });
  await expect(addWindow).toBeEnabled({ timeout: 30_000 });
  await addWindow.click();
  await expect(windowDialog).toBeVisible();
  await windowDialog.getByLabel("С", { exact: true }).fill("10:00");
  await windowDialog.getByLabel("До", { exact: true }).fill("12:00");
  await windowDialog.getByRole("checkbox", { name: "Повторять каждую неделю" }).check();
  await windowDialog.getByRole("button", { name: "Сохранить окно" }).click();
  await expect(windowDialog).toBeHidden({ timeout: 30_000 });
  await expect(monday).toContainText("10:00–12:00");
  await saveShot(page, "booking-calendar.png");

  // Настройка лидмагнита
  await page.goto(`/lead-magnets/${lead.id}`);
  await openTab(page, "Настройки");
  const block = page.getByTestId("call-booking-settings");
  await block.getByRole("checkbox", { name: /Записывать на созвон/ }).check();
  await block.getByLabel("Когда предложить").fill("Когда человек хочет обсудить свою задачу лично");
  await block.getByLabel("Ссылка на встречу").fill(MEETING_LINK);
  await block.scrollIntoViewIfNeeded();
  await saveShot(block, "booking-setting.png");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible({ timeout: 30_000 });

  // «Проверка»: запись тестовая — эксперт видит её, реальное время не занято
  await openTab(page, "Разговор");
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  const previewInput = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(async () => {
    await previewInput.fill("Запишите меня на созвон");
    await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await previewInput.press("Enter");
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.callBookedReply })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("preview-call-booking")).toContainText("Тестовая запись на созвон", { timeout: 30_000 });
  expect(await db.select().from(callBookings).where(isNull(callBookings.testChatId))).toEqual([]);
  expect(await db.select().from(callBookings).where(isNotNull(callBookings.testChatId))).toHaveLength(1);

  // «Записи»: эксперт подключает бота для уведомлений — «Старт» по ссылке
  await page.goto("/call-bookings");
  await expect(page.getByText("Записей пока нет", { exact: false })).toBeVisible({ timeout: 30_000 });
  const noticeBot = page.getByTestId(`notice-bot-${bot!.id}`);
  await noticeBot.getByRole("button", { name: "Подключить" }).click();
  const connectLink = noticeBot.getByTestId("notice-connect-link");
  await expect(connectLink).toBeVisible({ timeout: 30_000 });
  const startCode = new URL((await connectLink.getAttribute("href"))!).searchParams.get("start")!;
  expect(startCode).toBeTruthy();
  const expertChat = `tg-expert-${tag}`;
  const started = await request.post(`/api/webhooks/telegram/${bot!.id}`, {
    headers: { ...FRESH_CONNECTION, "x-fake-secret": bot!.webhookSecret },
    data: { events: [{ type: "message", dedupeKey: `e2e:${tag}:expert-start`, userId: expertChat, userName: "Эксперт", text: `/start ${startCode}`, startCode }] },
  });
  expect(started.status()).toBe(200);
  await expect(noticeBot.getByText("Подключён")).toBeVisible({ timeout: 60_000 });
  await saveShot(page.getByTestId("call-notices"), "booking-notices.png");

  // Живой разговор в веб-чате: человек записывается
  await publishWithBots(db, lead.id, { telegram: bot!.id });
  await page.goto(`/lead-magnets/${lead.id}/publish`);
  await expect(page.getByTestId("entry-link-web")).toContainText("/c/", { timeout: 30_000 });
  const webUrl = await page.getByTestId("entry-link-web").innerText();
  const visitor = await browser.newContext();
  const chat = await visitor.newPage();
  await chat.goto(new URL(webUrl).pathname);
  const feed = chat.getByRole("log", { name: "Переписка" });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  await chat.getByRole("textbox", { name: "Сообщение" }).fill("Запишите меня на созвон");
  await chat.getByRole("button", { name: "Отправить" }).click();
  await expect(feed.getByText(E2E_SCRIPT.callBookedReply)).toBeVisible({ timeout: 60_000 });
  await visitor.close();

  const [booking] = await db.select().from(callBookings).where(isNull(callBookings.testChatId));
  expect(booking).toMatchObject({ status: "booked", leadMagnetId: lead.id, meetingLink: MEETING_LINK });

  // Запись видна в «Записях» со ссылкой на карточку человека
  await page.goto("/call-bookings");
  const row = page.getByRole("row").filter({ hasText: leadName });
  await expect(row).toContainText("записан", { timeout: 30_000 });
  await expect(row.getByRole("link").first()).toHaveAttribute("href", `/people/${booking!.personId}`);
  await saveShot(page, "booking-records.png");

  // Уведомление о новой записи ушло через подключённого бота
  await expect
    .poll(async () => (await db.select().from(callNotices).where(and(eq(callNotices.bookingId, booking!.id), eq(callNotices.kind, "booked")))).map((notice) => notice.status), {
      timeout: 60_000,
    })
    .toEqual(["sent"]);
  const [notice] = await db.select().from(callNotices).where(eq(callNotices.bookingId, booking!.id));
  expect(notice!.text).toContain("Новая запись на созвон");
  expect(notice!.text).toContain(leadName);

  // Эксперт отменяет запись и пишет человеку своими словами: сообщение уходит туда, где человек разговаривает
  const cancelButton = row.getByRole("button", { name: "Отменить", exact: true });
  await expect(cancelButton).toBeEnabled({ timeout: 30_000 });
  await cancelButton.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox", { name: "Сообщить человеку" })).toBeChecked();
  const ownWords = "Простите, заболел. Выберем другой день?";
  await dialog.getByRole("textbox", { name: "Своими словами" }).fill(ownWords);
  await saveShot(dialog, "booking-cancel-dialog.png");
  await dialog.getByRole("button", { name: "Отменить запись" }).click();
  await expect(row).toContainText("отменили вы", { timeout: 30_000 });
  await expect
    .poll(async () => (await db.select().from(outboundMessages).where(eq(outboundMessages.idempotencyKey, `call-cancelled:${booking!.id}`))).map((one) => [one.text, one.status]), {
      timeout: 60_000,
    })
    .toEqual([[ownWords, "sent"]]);
});
