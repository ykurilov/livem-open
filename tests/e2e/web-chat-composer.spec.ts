import { expect, test, type Browser, type BrowserContextOptions, type Locator, type Page } from "@playwright/test";
import { bots } from "../../src/modules/channels/schema";
import { createLabeledLink, createLeadMagnet, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";

// Микрофон подменён: браузер сам разрешает доступ и пишет искусственный звук, Soniox — подставной (start-server.ts)
test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

/** Снимки для отчёта, не эталоны: забираются с машины прогона вместе с `test-results`. */
const SHOTS = "test-results/composer-shots";
const DESKTOP = { viewport: { width: 1440, height: 900 } } satisfies BrowserContextOptions;
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } satisfies BrowserContextOptions;
const FOUR_LINES = "Первая строка\nВторая строка\nТретья строка\nЧетвёртая строка";

let connection: DatabaseConnection;

test.beforeAll(() => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
});

test.afterAll(async () => {
  await connection.close();
});

/** Опубликованный лидмагнит с включённым «Голосовым вводом»; адрес веб-чата. */
async function publishedWebChat(tag: string): Promise<string> {
  const { db } = connection;
  const lead = await createLeadMagnet(db, { name: `Поле ввода ${tag}` });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage, voiceInput: true }, "manual");
  const token = `fake-composer${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот поля ввода ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_composer${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  await publishWithBots(db, lead.id, { telegram: bot!.id });
  const link = await createLabeledLink(db, { leadMagnetId: lead.id, label: `Поле ввода ${tag}` });
  return `/c/${link.code}`;
}

/** Открытый чат с готовым к вводу полем. */
async function openChat(browser: Browser, path: string, options: BrowserContextOptions) {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce", permissions: ["microphone"] });
  const page = await context.newPage();
  await page.goto(path);
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  const input = page.getByRole("textbox", { name: "Сообщение" });
  await expect(page.getByRole("log", { name: "Переписка" }).getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  await expect(input).toBeEnabled();
  return { context, page, input, field: page.locator(".web-chat__field"), send: page.getByRole("button", { name: "Отправить" }), mic: page.getByRole("button", { name: "Диктовать" }) };
}

/** Отступы кнопки от краёв рамки поля. */
async function gaps(field: Locator, button: Locator) {
  const outer = (await field.boundingBox())!;
  const inner = (await button.boundingBox())!;
  return {
    top: inner.y - outer.y,
    bottom: outer.y + outer.height - (inner.y + inner.height),
    right: outer.x + outer.width - (inner.x + inner.width),
    fieldHeight: outer.height,
  };
}

/** Сторона квадрата вокруг центра кнопки, касание в котором попадает в неё. */
async function touchSide(page: Page, button: Locator): Promise<number> {
  const box = (await button.boundingBox())!;
  const center = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const handle = await button.elementHandle();
  return page.evaluate(
    ({ center, element }) => {
      const hits = (dx: number, dy: number) => document.elementFromPoint(center.x + dx, center.y + dy)?.closest("button") === element;
      // Пробы — по целым пикселям: дробную точку на стыке областей двух кнопок браузер относит к обеим и отдаёт верхнюю.
      // Квадрат со стороной 2n занимает пиксели от −n до n−1
      let half = 0;
      while (half < 40 && [[-half - 1, -half - 1], [half, -half - 1], [-half - 1, half], [half, half]].every(([dx, dy]) => hits(dx!, dy!))) half++;
      return half * 2;
    },
    { center, element: handle },
  );
}

test("поле ввода: кнопки стоят ровно — по центру у одной строки, у нижнего края при нескольких, отступы от краёв равные", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, input, field, send, mic } = await openChat(browser, await publishedWebChat(Date.now().toString(36)), DESKTOP);

  for (const text of ["", "Здравствуйте!"]) {
    await input.fill(text);
    const one = await gaps(field, send);
    expect(Math.abs(one.top - one.bottom), `одна строка «${text}»: кнопка по центру`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(one.right - one.bottom), `одна строка «${text}»: справа столько же, сколько снизу`).toBeLessThanOrEqual(0.5);
  }
  const oneLine = await gaps(field, send);
  const micBox = (await mic.boundingBox())!;
  const sendBox = (await send.boundingBox())!;
  expect(Math.abs(micBox.y + micBox.height / 2 - (sendBox.y + sendBox.height / 2)), "микрофон на одной линии с отправкой").toBeLessThanOrEqual(0.5);

  await input.fill(FOUR_LINES);
  const many = await gaps(field, send);
  expect(many.fieldHeight, "поле выросло под текст").toBeGreaterThan(oneLine.fieldHeight + 40);
  expect(Math.abs(many.bottom - oneLine.bottom), "несколько строк: кнопка у нижнего края").toBeLessThanOrEqual(0.5);
  expect(Math.abs(many.right - oneLine.right)).toBeLessThanOrEqual(0.5);
  await context.close();
});

test("поле ввода на телефоне: в кнопки удобно попасть пальцем, поле не вылезает за экран", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page, input, field, send, mic } = await openChat(browser, await publishedWebChat(`m${Date.now().toString(36)}`), PHONE);
  await input.fill("Здравствуйте!");

  expect(await touchSide(page, send), "область нажатия «Отправить»").toBeGreaterThanOrEqual(44);
  expect(await touchSide(page, mic), "область нажатия «Диктовать»").toBeGreaterThanOrEqual(44);
  const box = (await field.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.viewport.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.viewport.width);
  await context.close();
});

const SHOT_PROFILES = [
  { name: "desktop-light", options: { ...DESKTOP, colorScheme: "light" } },
  { name: "desktop-dark", options: { ...DESKTOP, colorScheme: "dark" } },
  { name: "phone-light", options: { ...PHONE, colorScheme: "light" } },
  { name: "phone-dark", options: { ...PHONE, colorScheme: "dark" } },
] satisfies { name: string; options: BrowserContextOptions }[];

for (const profile of SHOT_PROFILES) {
  test(`снимки состояний поля ввода: ${profile.name}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const path = await publishedWebChat(`${profile.name}${Date.now().toString(36)}`);
    const options = { ...profile.options, deviceScaleFactor: 2 };
    const { width, height } = profile.options.viewport;
    // Низ экрана: хвост ленты и поле; на компьютере — только колонка чата
    const stripWidth = Math.min(width, 790);
    const clip = { x: (width - stripWidth) / 2, y: height - 300, width: stripWidth, height: 300 };
    const shoot = (page: Page, state: string) =>
      page.screenshot({ path: `${SHOTS}/${profile.name}-${state}.png`, clip, animations: "disabled", caret: "hide" });

    // Вход ещё идёт: поле неактивно
    const loadingContext = await browser.newContext({ ...options, reducedMotion: "reduce" });
    const loading = await loadingContext.newPage();
    let openSession = () => {};
    const sessionHeld = new Promise<void>((resolve) => (openSession = resolve));
    await loading.route("**/api/web-chat/session", async (route) => {
      await sessionHeld;
      await route.continue().catch(() => {});
    });
    await loading.goto(path);
    await loading.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await expect(loading.getByRole("textbox", { name: "Сообщение" })).toBeDisabled();
    await expect(loading.getByText("Открываем чат…")).toBeVisible();
    await shoot(loading, "7-inactive");
    openSession();
    await loadingContext.close();

    const { context, page, input, send, mic } = await openChat(browser, path, options);
    await shoot(page, "1-empty");
    await page.screenshot({ path: `${SHOTS}/${profile.name}-page.png`, animations: "disabled", caret: "hide" });
    await input.focus();
    await shoot(page, "2-focus");
    await input.fill("Можно вопрос про запись?");
    await shoot(page, "3-text");
    await input.fill(FOUR_LINES);
    await shoot(page, "4-multiline");

    await input.fill("");
    await mic.click();
    await expect(page.getByRole("button", { name: "Остановить диктовку" })).toBeVisible({ timeout: 15_000 });
    await expect(input).not.toHaveValue("", { timeout: 15_000 });
    await shoot(page, "5-recording");
    await page.getByRole("button", { name: "Остановить диктовку" }).click();
    await expect(mic).toBeVisible({ timeout: 15_000 });

    // Сообщение уходит: ответ сервера придержан, пока снимается экран
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/web-chat/messages", async (route) => {
      if (route.request().method() === "POST") await held;
      await route.continue().catch(() => {});
    });
    await input.fill(`Какие есть ${E2E_SCRIPT.quickRepliesTrigger}?`);
    const posted = page.waitForRequest((request) => request.method() === "POST" && request.url().includes("/api/web-chat/messages"));
    await send.click();
    await posted;
    await shoot(page, "6-sending");
    release();
    await expect(page.getByRole("group", { name: "Быстрые ответы" }).getByRole("button")).toHaveText([...E2E_SCRIPT.quickReplies], { timeout: 30_000 });
    await expect(input).toHaveValue("");
    // Быстрые ответы — в ленте над полем: экран целиком
    await page.screenshot({ path: `${SHOTS}/${profile.name}-quick-replies.png`, animations: "disabled", caret: "hide" });
    await context.close();
  });
}

test("набранное в веб-чате переживает перезагрузку страницы и пропадает после отправки", async ({ browser }) => {
  test.setTimeout(120_000);
  const path = await publishedWebChat(`draft${Date.now().toString(36)}`);
  const { context, page, input, send } = await openChat(browser, path, DESKTOP);
  await input.fill("Хочу спросить про цены");
  await page.reload();
  await expect(input).toHaveValue("Хочу спросить про цены", { timeout: 30_000 });

  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByRole("log", { name: "Переписка" }).getByText("Хочу спросить про цены")).toBeVisible({ timeout: 30_000 });
  await expect(input).toHaveValue("");
  await page.reload();
  await expect(page.getByRole("log", { name: "Переписка" }).getByText("Хочу спросить про цены")).toBeVisible({ timeout: 30_000 });
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("");
  await context.close();
});
