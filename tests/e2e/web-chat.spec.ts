import { expect, test } from "@playwright/test";
import { and, eq, isNull } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { inboundMessages, passages } from "../../src/modules/conversations/schema";
import { createImage } from "../../src/modules/images";
import { createLabeledLink, createLeadMagnet, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
import { unpublishLeadMagnet } from "../../src/modules/lead-magnets/publish";
import { entryLinks } from "../../src/modules/lead-magnets/schema";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";

let connection: DatabaseConnection;

test.beforeAll(() => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
});

test.afterAll(async () => {
  await connection.close();
});

// Настоящая PNG 1×1: страница чата её загружает и рисует
const SCREENSHOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("ссылка с меткой открывает веб-чат: разговор с картинкой, человек в «Людях» с меткой, ответ эксперта приходит на открытую страницу", async ({ browser, page }) => {
  test.setTimeout(180_000);
  const { db } = connection;
  const tag = Date.now().toString(36);

  // Лидмагнит с картинкой — сразу в базе: публикацию и архив картинок проверяют другие сценарии
  const image = await createImage(db, { title: `Кнопка ${tag}`, description: `Где нажать: ${E2E_SCRIPT.imageQuery} слева, ${tag}.` }, { bytes: SCREENSHOT });
  const leadName = `Веб-чат ${tag}`;
  const lead = await createLeadMagnet(db, { name: leadName });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage, imageIds: [image.id] }, "manual");
  // Без мессенджера лидмагнит не публикуется: свой тестовый бот Telegram
  const token = `fake-webchat${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот веб-чата ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_webchat${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  await publishWithBots(db, lead.id, { telegram: bot!.id });
  const label = `Блогер ${tag}`;
  const link = await createLabeledLink(db, { leadMagnetId: lead.id, label });

  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await page.context().addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);

  // Эксперт видит веб-ссылку рядом с мессенджерами и у ссылки с меткой
  await page.goto(`/lead-magnets/${lead.id}/publish`);
  await expect(page.getByTestId("entry-link-web")).toContainText("/c/", { timeout: 30_000 });
  const labeledUrl = await page.getByTestId("labeled-link-web").innerText();
  expect(labeledUrl).toContain(`/c/${link.code}`);

  // Посетитель без входа: своя чистая сессия браузера
  const visitorContext = await browser.newContext();
  const chat = await visitorContext.newPage();
  await chat.goto(new URL(labeledUrl).pathname);
  const feed = chat.getByRole("log", { name: "Переписка" });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  // Один посетитель на загрузку страницы — одно первое сообщение
  await chat.waitForTimeout(3000);
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toHaveCount(1);

  const input = chat.getByRole("textbox", { name: "Сообщение" });
  const say = async (text: string) => {
    await input.fill(text);
    await chat.getByRole("button", { name: "Отправить" }).click();
    await expect(feed.getByText(text)).toBeVisible();
  };

  // Консультант показывает картинку из архива — в ленте картинкой, а не ссылкой
  await say(`Пришли ${E2E_SCRIPT.imageTrigger}, где нажать`);
  const shown = feed.getByRole("img", { name: "Картинка от консультанта" });
  // Адрес картинки в `next dev` может собираться впервые
  await expect(shown).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => shown.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(1);
  await expect(feed.getByText(E2E_SCRIPT.imageReply)).toBeVisible();

  // Разговор окончен — следующее сообщение уходит эксперту во «Входящие»
  await say(`Я ${E2E_SCRIPT.finishTrigger} к созвону`);
  await expect
    .poll(async () => (await db.select().from(passages).where(and(eq(passages.leadMagnetId, lead.id), eq(passages.status, "completed")))).length, { timeout: 30_000 })
    .toBe(1);
  const question = `А когда созвон, ${tag}?`;
  await say(question);
  // Во «Входящие» сообщение попадает после разбора работником, а страница «Входящих» сама не обновляется
  await expect
    .poll(async () => (await db.select().from(inboundMessages).where(and(eq(inboundMessages.text, question), eq(inboundMessages.route, "inbox")))).length, { timeout: 30_000 })
    .toBe(1);

  // Человек в «Людях»: канал «Веб-чат», находится по метке
  // Фильтр открываем адресом, а не формой: `next dev` бывает перезагружает открытые страницы, и нажатие теряется
  await page.goto("/people");
  await expect(page.getByRole("combobox", { name: "Метка" })).toContainText(`${label} — ${leadName}`);
  await page.goto(`/people?link=${link.id}`);
  await expect(page.getByTestId("people-count")).toHaveText("Найдено: 1");
  const row = page.getByRole("row").filter({ hasText: leadName });
  await expect(row).toContainText("Веб-чат");
  const personHref = (await row.getByRole("link").first().getAttribute("href"))!;
  expect(personHref).toMatch(/^\/people\/[0-9a-f-]{36}$/);
  const personId = personHref.split("/").at(-1)!;

  // Ответ эксперта из «Входящих» появляется на открытой странице без перезагрузки
  await page.goto(`/inbox?person=${personId}`);
  await expect(page.getByTestId("inbox-messages")).toContainText(question);
  await page.getByLabel("Ваш ответ").fill(`Завтра в 12:00, ${tag}`);
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(feed.getByText(`Завтра в 12:00, ${tag}`)).toBeVisible({ timeout: 30_000 });

  // Веб-приложение с экрана «Домой» начинает без cookie: манифест перечитан после входа, в адресе старта — код входа, не токен
  await expect.poll(() => chat.evaluate(() => document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href ?? "")).toContain("?v=");
  const manifest = (await (await visitorContext.request.get(`/c/${link.code}/manifest.webmanifest`)).json()) as { start_url: string };
  const cookieToken = (await visitorContext.cookies()).find((cookie) => cookie.name === "lm_chat")!.value;
  expect(manifest.start_url).toContain("?resume=");
  expect(manifest.start_url).not.toContain(cookieToken);
  // Та же ссылка в обычной вкладке чужого браузера — не вход: код действует только в веб-приложении с экрана «Домой»
  const stranger = await browser.newContext();
  const strangerPage = await stranger.newPage();
  const strangerSession = strangerPage.waitForRequest((request) => request.url().endsWith("/api/web-chat/session"));
  await strangerPage.goto(manifest.start_url);
  expect(JSON.parse((await strangerSession).postData() ?? "{}")).toMatchObject({ resume: null });
  await expect(strangerPage).toHaveURL(new RegExp(`/c/${link.code}$`));
  await expect(strangerPage.getByRole("log", { name: "Переписка" })).not.toContainText(tag);
  await stranger.close();

  const installed = await browser.newContext();
  await installed.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
  const app = await installed.newPage();
  await app.goto(manifest.start_url);
  await expect(app.getByRole("log", { name: "Переписка" }).getByText(`Завтра в 12:00, ${tag}`)).toBeVisible({ timeout: 30_000 });
  await expect(app).toHaveURL(new RegExp(`/c/${link.code}$`));
  await installed.close();

  // Снимок на ширине телефона — для глаз, не для сравнения
  await chat.setViewportSize({ width: 390, height: 844 });
  await chat.screenshot({ path: test.info().outputPath("web-chat-phone.png") });
  await visitorContext.close();
});

/** Опубликованный лидмагнит со своим тестовым ботом Telegram; код основной ссылки — адрес веб-чата `/c/<код>`. */
async function publishedLeadMagnet(name: string) {
  const { db } = connection;
  const lead = await createLeadMagnet(db, { name });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
  const token = `fake-closed${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот ${name}`,
      externalId: `ext-${token}`,
      username: `bot_${token.replace(/-/g, "")}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  await publishWithBots(db, lead.id, { telegram: bot!.id });
  const [main] = await db.select().from(entryLinks).where(and(eq(entryLinks.leadMagnetId, lead.id), isNull(entryLinks.label)));
  return { id: lead.id, code: main!.code };
}

test("снятый с публикации чат и неизвестная ссылка — не тупик: «чат закончен» или «не найден» и переход в текущий", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = Date.now().toString(36);
  const closed = await publishedLeadMagnet(`Закрытый ${tag}`);
  const current = await publishedLeadMagnet(`Текущий ${tag}`);

  const visitor = await browser.newContext();
  const chat = await visitor.newPage();
  const feed = chat.getByRole("log", { name: "Переписка" });
  await chat.goto(`/c/${closed.code}`);
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  await chat.goto(`/c/${current.code}`);
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toHaveCount(2, { timeout: 30_000 });
  await unpublishLeadMagnet(connection.db, closed.id);

  // Старая закладка: ни чужой ленты под этим названием, ни поля ввода — только переход
  await chat.goto(`/c/${closed.code}`);
  await expect(chat.getByRole("heading", { name: `Закрытый ${tag}` })).toBeVisible();
  await expect(chat.getByText("Этот чат закончен")).toBeVisible();
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toHaveCount(0);
  await expect(chat.getByRole("textbox", { name: "Сообщение" })).toHaveCount(0);
  await chat.getByRole("link", { name: "Перейти в текущий чат" }).click();
  await expect(chat).toHaveURL(new RegExp(`/c/${current.code}$`));
  await expect(chat.getByRole("heading", { name: `Текущий ${tag}` })).toBeVisible();
  await expect(chat.getByRole("textbox", { name: "Сообщение" })).toBeEnabled({ timeout: 30_000 });

  // Неизвестная ссылка — русская страница и путь в свой чат; новому посетителю снятый чат — та же страница
  await chat.goto(`/c/missing-${tag}`);
  await expect(chat.getByRole("heading", { name: "Чат не найден" })).toBeVisible();
  await expect(chat.getByText(`«Текущий ${tag}»`)).toBeVisible();
  await chat.getByRole("link", { name: "Вернуться в мой чат" }).click();
  await expect(chat).toHaveURL(new RegExp(`/c/${current.code}$`));
  await visitor.close();
  const stranger = await browser.newContext();
  const strangerChat = await stranger.newPage();
  await strangerChat.goto(`/c/${closed.code}`);
  await expect(strangerChat.getByRole("heading", { name: "Чат не найден" })).toBeVisible();
  await expect(strangerChat.getByText("попросите у автора новую ссылку")).toBeVisible();
  await stranger.close();
});

test("повисшее открытие, повисшая отправка и сообщение из старой вкладки — не тупик: повтор без двойного сообщения и переход без обновления страницы", async ({ browser }) => {
  test.setTimeout(180_000);
  const tag = Date.now().toString(36);
  const first = await publishedLeadMagnet(`Первый ${tag}`);
  const second = await publishedLeadMagnet(`Второй ${tag}`);

  // Веб-приложение с экрана «Домой»: обновить страницу нечем, повтор — кнопкой
  const visitor = await browser.newContext();
  const chat = await visitor.newPage();
  // Сервер не отвечает (сеть «полуоткрыта»): запрос повисает, а не обрывается
  let sessionHangs = 1;
  await chat.route("**/api/web-chat/session", (route) => (sessionHangs-- > 0 ? undefined : route.continue()));
  await chat.goto(`/c/${first.code}`);
  await expect(chat.getByText("Не получилось открыть чат")).toBeVisible({ timeout: 30_000 });
  await expect(chat.getByRole("textbox", { name: "Сообщение" })).toBeDisabled();
  await chat.getByRole("button", { name: "Попробовать снова" }).click();
  await expect(chat.getByRole("textbox", { name: "Сообщение" })).toBeEnabled({ timeout: 30_000 });
  await expect(chat.getByRole("log", { name: "Переписка" }).getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });

  // Сообщение дошло до сервера, а ответ повис: ошибка с повтором, текст в поле, повтор не задваивает сообщение
  const hung = `Повисло ${tag}`;
  let sendHangs = 1;
  await chat.route("**/api/web-chat/messages", async (route) => {
    if (route.request().method() !== "POST" || sendHangs-- <= 0) return route.fallback();
    await route.fetch();
  });
  await chat.getByRole("textbox", { name: "Сообщение" }).fill(hung);
  await chat.getByRole("button", { name: "Отправить" }).click();
  await expect(chat.getByText("Не получилось отправить")).toBeVisible({ timeout: 30_000 });
  await expect(chat.getByRole("textbox", { name: "Сообщение" })).toHaveValue(hung);
  await chat.getByRole("button", { name: "Отправить" }).click();
  await expect(chat.getByRole("textbox", { name: "Сообщение" })).toHaveValue("", { timeout: 30_000 });
  await expect(chat.getByRole("log", { name: "Переписка" }).getByText(hung)).toHaveCount(1);
  expect(await connection.db.select().from(inboundMessages).where(eq(inboundMessages.text, hung))).toHaveLength(1);

  // Во второй вкладке начался другой разговор — сообщение из первой показывает, где он идёт, черновик не пропадает
  const other = await visitor.newPage();
  await other.goto(`/c/${second.code}`);
  await expect(other.getByRole("log", { name: "Переписка" }).getByText(E2E_SCRIPT.firstMessage)).toHaveCount(2, { timeout: 30_000 });
  await chat.getByRole("textbox", { name: "Сообщение" }).fill(`Ответ про первый ${tag}`);
  await chat.getByRole("button", { name: "Отправить" }).click();
  await expect(chat.getByText(`Сейчас у вас идёт разговор «Второй ${tag}»`)).toBeVisible({ timeout: 30_000 });
  await expect(chat.getByRole("link", { name: "Перейти в текущий чат" })).toHaveAttribute("href", `/c/${second.code}`);
  await chat.getByRole("button", { name: "Вернуться в этот чат" }).click();
  await expect(chat.getByRole("textbox", { name: "Сообщение" })).toBeEnabled({ timeout: 30_000 });
  await expect(chat.getByRole("textbox", { name: "Сообщение" })).toHaveValue(`Ответ про первый ${tag}`);
  await visitor.close();
});
