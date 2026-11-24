import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { saveAllowedSites } from "../../src/modules/chat-api";
import { inboundMessages } from "../../src/modules/conversations/schema";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";
import { passagesOf, publishedLeadMagnet, startExpertSite, type ExpertSite } from "./site-widget-kit";

let connection: DatabaseConnection;
let site: ExpertSite;

test.beforeAll(async () => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
  site = await startExpertSite();
});

test.afterAll(async () => {
  await Promise.all([connection.close(), site.close()]);
});

const tagOf = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test("кнопка на чужом сайте: CSS сайта меняет цвет и место кнопки, прочие стили сайта виджет не трогают, разговор идёт без cookie", async ({ page }) => {
  test.setTimeout(120_000);
  const { db } = connection;
  const lead = await publishedLeadMagnet(db, tagOf(), "Кнопка");
  await site.open(page, {
    code: lead.code,
    mode: "button",
    css: `livem-chat { --livem-color: rgb(10, 120, 60); --livem-offset-x: 64px; }
      body { font-size: 30px; color: rgb(255, 0, 0); line-height: 3; } button { background: rgb(255, 0, 0); padding: 40px; }`,
  });

  const launcher = page.getByRole("button", { name: `Открыть чат «${lead.name}»` });
  await expect(launcher).toBeVisible({ timeout: 30_000 });
  await expect(launcher).toHaveCSS("background-color", "rgb(10, 120, 60)");
  const box = (await launcher.boundingBox())!;
  expect(Math.round(page.viewportSize()!.width - (box.x + box.width))).toBe(64);
  expect(Math.round(box.width)).toBe(56);
  // До нажатия разговор не начинается: заход на сайт модель не тратит
  expect(await passagesOf(db, lead.id)).toHaveLength(0);

  await launcher.click();
  const window = page.getByRole("dialog", { name: lead.name });
  const feed = window.getByRole("log", { name: "Переписка" });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).not.toHaveCSS("color", "rgb(255, 0, 0)");
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).not.toHaveCSS("font-size", "30px");

  await window.getByRole("textbox", { name: "Сообщение" }).fill("Здравствуйте, я с сайта");
  await window.getByRole("button", { name: "Отправить" }).click();
  await expect(feed.getByText("Здравствуйте, я с сайта")).toBeVisible();
  await expect(feed.getByText(E2E_SCRIPT.consultantReply)).toBeVisible({ timeout: 30_000 });

  // Разговор — веб-чата: у лидмагнита, сообщение человека — во входящих эксперта
  expect(await passagesOf(db, lead.id)).toHaveLength(1);
  const inbound = await db.select({ id: inboundMessages.id }).from(inboundMessages).where(eq(inboundMessages.text, "Здравствуйте, я с сайта"));
  expect(inbound).toHaveLength(1);
  // Посетитель — по токену в хранилище сайта: приложение cookie не ставит
  expect(await page.context().cookies(E2E_BASE_URL)).toHaveLength(0);

  await page.getByRole("button", { name: "Закрыть чат" }).first().click();
  await expect(window).toBeHidden();
});

test("блок на чужом сайте начинает разговор, когда показался на экране, и продолжает его после обновления страницы", async ({ page }) => {
  test.setTimeout(120_000);
  const { db } = connection;
  const lead = await publishedLeadMagnet(db, tagOf(), "Блок");
  await site.open(page, { code: lead.code, mode: "inline", before: `<div style="height: 2400px">Длинная страница</div>` });

  const feed = page.getByRole("log", { name: "Переписка" });
  await page.waitForTimeout(2000);
  expect(await passagesOf(db, lead.id)).toHaveLength(0);

  await page.locator("livem-chat").scrollIntoViewIfNeeded();
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("textbox", { name: "Сообщение" }).fill("Первое сообщение из блока");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(feed.getByText(E2E_SCRIPT.consultantReply)).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await page.locator("livem-chat").scrollIntoViewIfNeeded();
  await expect(feed.getByText("Первое сообщение из блока")).toBeVisible({ timeout: 30_000 });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toHaveCount(1);
  expect(await passagesOf(db, lead.id)).toHaveLength(1);
});

test("на сайте не из списка разрешённых виджета нет: причина в консоли, разговор не начинается", async ({ page }) => {
  const { db } = connection;
  const lead = await publishedLeadMagnet(db, tagOf(), "Чужой сайт");
  await saveAllowedSites(db, lead.id, "expert-site.ru");
  const warning = page.waitForEvent("console", { predicate: (message) => message.text().startsWith("Виджет лидмагнита:"), timeout: 30_000 });
  await site.open(page, { code: lead.code, mode: "inline" });

  expect((await warning).text()).toContain("не работает на сайте 127.0.0.1");
  await expect(page.getByRole("log", { name: "Переписка" })).toHaveCount(0);
  expect(await passagesOf(db, lead.id)).toHaveLength(0);
});

test.describe("телефон", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("окно кнопки — во весь экран, кнопка под ним прячется", async ({ page }) => {
    const { db } = connection;
    const lead = await publishedLeadMagnet(db, tagOf(), "Телефон");
    await site.open(page, { code: lead.code, mode: "button" });
    await page.getByRole("button", { name: `Открыть чат «${lead.name}»` }).tap({ timeout: 30_000 });
    const window = page.getByRole("dialog", { name: lead.name });
    await expect(window.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
    expect(await window.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await expect(page.getByRole("button", { name: `Открыть чат «${lead.name}»` })).toHaveCount(0);
  });
});

test("«Встроить на сайт» в кабинете: код, просмотр, сайты, ключ API и документация без входа", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const { db } = connection;
  const lead = await publishedLeadMagnet(db, tagOf(), "Кабинет");
  const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
  await page.context().addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/lead-magnets/${lead.id}/publish`);

  const card = page.locator(".yk-card", { has: page.getByRole("heading", { name: "Встроить на сайт" }) });
  const embed = card.getByTestId("widget-embed-code");
  await expect(embed).toContainText(`${E2E_BASE_URL}/widget.js`, { timeout: 30_000 });
  await expect(embed).toContainText('mode="button"');
  await card.getByText("Блок на странице").click();
  await expect(embed).toContainText('mode="inline"');
  await card.getByRole("button", { name: /^Скопировать · Код для сайта$/ }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('mode="inline"');

  await card.getByRole("button", { name: "Показать просмотр" }).click();
  const preview = card.getByTestId("widget-preview");
  await preview.scrollIntoViewIfNeeded();
  await expect(preview.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });

  const sites = card.getByRole("textbox", { name: "Сайты" });
  await sites.fill("example.ru\nэто не сайт");
  await card.getByRole("button", { name: "Сохранить сайты" }).click();
  await expect(card.getByText("Не похоже на адрес сайта: это не сайт", { exact: false })).toBeVisible();
  await sites.fill("example.ru\n*.example.ru");
  await card.getByRole("button", { name: "Сохранить сайты" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Сохранено" })).toBeVisible();

  await card.getByRole("button", { name: "Выпустить ключ" }).click();
  const shown = card.getByTestId("api-key-new");
  await expect(shown).toContainText("lmk_");
  const key = await shown.innerText();
  // Ключ показывается один раз: после обновления — только его начало
  await page.reload();
  await expect(card.getByTestId("api-key-current")).toContainText(key.slice(0, 8));
  await expect(card.getByTestId("api-key-current")).not.toContainText(key);
  await expect(card.getByRole("textbox", { name: "Сайты" })).toHaveValue("example.ru\n*.example.ru");
  await card.getByRole("button", { name: "Отозвать ключ" }).click();
  await expect(card.getByText("Ключа нет.")).toBeVisible();

  const docsHref = await card.getByRole("link", { name: "документация API для программиста" }).getAttribute("href");
  const visitor = await browser.newContext();
  const docs = await visitor.newPage();
  await docs.goto(`${E2E_BASE_URL}${docsHref}`);
  await expect(docs.getByRole("heading", { name: "API чата лидмагнита", level: 1 })).toBeVisible();
  await expect(docs.getByText("Livem-Visitor: user-42", { exact: false })).toBeVisible();
  await visitor.close();
});
