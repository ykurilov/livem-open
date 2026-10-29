import { expect, test, type Page } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { leadMagnets } from "../../src/modules/lead-magnets/schema";
import { createLeadMagnet, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
import { mailingRecipients, mailings } from "../../src/modules/mailings/schema";
import { createField } from "../../src/modules/people";
import { people } from "../../src/modules/people/schema";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";

// Снимки главных экранов в светлой и тёмной теме. Снимается только окно браузера (без прокрутки),
// а то, что меняется от прогона к прогону или зависит от чужих данных в общей базе, прячется.
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

const THEMES = ["light", "dark"] as const;

/**
 * Данные из общей базы и всё, что меняется от прогона к прогону: прячется целиком, чтобы высота страницы не зависела от чужих данных.
 * Переписки во «Входящих» — карточки-ссылки, их пишут параллельные тесты входящих: прячется содержимое колонки, сама колонка остаётся.
 * Из-за тех же переписок в меню появляется счётчик неотвеченных.
 */
const CHANGING_PARTS = 'main table, main ul, main ol, main [data-testid], main time, main code, main nav[aria-label="Неотвеченные"] > *, .app-navigation-count';

/** Подписка чата `GET …/watch` открыта всё время, пока виден чат: тишины в сети на редакторе не бывает. */
const isLongLived = (url: string) => new URL(url).pathname.endsWith("/watch");

/** Как `networkidle`, но без вечных подписок: полсекунды без других незаконченных запросов. */
async function waitForQuietNetwork(page: Page) {
  const pending = new Set<{ url(): string }>();
  const started = (request: { url(): string }) => !isLongLived(request.url()) && pending.add(request);
  const ended = (request: { url(): string }) => pending.delete(request);
  page.on("request", started);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  try {
    await page.waitForLoadState("load");
    let quietSince = Date.now();
    await expect
      .poll(
        () => {
          if (pending.size > 0) quietSince = Date.now();
          // При провале в отчёте видно, какие запросы так и не закончились
          return Date.now() - quietSince >= 500 ? [] : [...pending].map((request) => request.url());
        },
        { timeout: 60_000, intervals: [100] },
      )
      .toEqual([]);
  } finally {
    page.off("request", started);
    page.off("requestfinished", ended);
    page.off("requestfailed", ended);
  }
}

/** Метка стиля, который прячет меняющиеся куски: если вкладка перезагрузилась, стиля нет и снимок недействителен. */
const HIDING_MARK = "e2e-screenshot-hiding";

async function shoot(page: Page, path: string, name: string, mask: string | undefined) {
  for (const colorScheme of THEMES) {
    // Без движения: шарик в шапке рисует один неподвижный кадр
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    const loading = waitForQuietNetwork(page);
    await page.goto(path);
    await loading;
    // Значок разработки Next.js в углу — не часть кабинета; заодно прячутся меняющиеся куски
    await page.addStyleTag({ content: `/* ${HIDING_MARK} */ nextjs-portal, ${CHANGING_PARTS} { display: none !important; }` });
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    await expect(page).toHaveScreenshot(`${name}-${colorScheme}.png`, {
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
      caret: "hide",
      mask: mask ? [page.locator(mask)] : [],
    });
    expect(await page.evaluate((mark) => [...document.querySelectorAll("style")].some((style) => style.textContent?.includes(mark)), HIDING_MARK)).toBe(true);
  }
}

// База пересоздаётся при каждом прогоне, поэтому имена постоянные, а даты зафиксированы: снимки не плывут
const TAG = "снимков";
const SEED_LOCK = 7_300_001;

/** Данные для снимков: каждый экран снимается отдельным тестом (они идут параллельно), а общие данные создаются один раз за прогон. */
async function seedForShots(database: DatabaseConnection["db"]) {
  // Блокировка живёт до конца транзакции и занимает одно соединение: у базы их ограниченное число на все воркеры
  return database.transaction(async (db) => {
    await db.execute(sql`select pg_advisory_xact_lock(${SEED_LOCK})`);
    const [existing] = await db.select().from(leadMagnets).where(sql`${leadMagnets.draft}->>'name' = ${`Снимки ${TAG}`}`);
    const fixedDate = new Date("2026-01-15T12:00:00Z");
    if (existing) {
      const [emptyLead] = await db.select().from(leadMagnets).where(sql`${leadMagnets.draft}->>'name' = ${`Пустой ${TAG}`}`);
      const [person] = await db.select().from(people).where(eq(people.externalUserId, `shot-${TAG}`));
      const [draft] = await db.select().from(mailings).where(eq(mailings.text, `Черновик ${TAG}`));
      const [report] = await db.select().from(mailings).where(eq(mailings.text, `Отчёт ${TAG}`));
      return { lead: existing, emptyLead: emptyLead!, person: person!, draft: draft!, report: report! };
    }
    // Свои бот, лидмагнит, поле, человек и рассылки — сразу в базе
    const token = `fake-shot${TAG}`;
    const [bot] = await db
      .insert(bots)
      .values({
        channel: "telegram",
        title: `Бот снимков ${TAG}`,
        externalId: `ext-${token}`,
        username: `bot_shot${TAG}`,
        tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
        webhookSecret: `secret-${token}`,
      })
      .returning();
    const lead = await createLeadMagnet(db, { name: `Снимки ${TAG}` });
    const emptyLead = await createLeadMagnet(db, { name: `Пустой ${TAG}` });
    await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
    await publishWithBots(db, lead.id, { telegram: bot!.id });
    await createField(db, { name: `Поле снимков ${TAG}`, type: "boolean", description: "" });
    const [person] = await db.insert(people).values({ channel: "telegram", botId: bot!.id, externalUserId: `shot-${TAG}`, displayName: `Человек ${TAG}`, createdAt: fixedDate }).returning();
    const [draft] = await db.insert(mailings).values({ text: `Черновик ${TAG}` }).returning();
    const [report] = await db
      .insert(mailings)
      .values({ text: `Отчёт ${TAG}`, status: "done", recipientCount: 1, startedAt: fixedDate, finishedAt: fixedDate })
      .returning();
    await db.insert(mailingRecipients).values({ mailingId: report!.id, personId: person!.id, botId: bot!.id, error: "Бот отключён" });
    return { lead, emptyLead, person: person!, draft: draft!, report: report! };
  });
}

type Seed = Awaited<ReturnType<typeof seedForShots>>;

/** `mask` — поля с общими данными, которые параллельно меняют другие тесты: на снимке их место закрашено. */
const SCREENS: { name: string; path: (seed: Seed) => string; mask?: string }[] = [
  { name: "home", path: () => "/" },
  { name: "editor", path: (seed) => `/lead-magnets/${seed.lead.id}` },
  { name: "editor-empty", path: (seed) => `/lead-magnets/${seed.emptyLead.id}` },
  { name: "publish", path: (seed) => `/lead-magnets/${seed.lead.id}/publish` },
  { name: "bots", path: () => "/bots" },
  { name: "people", path: () => "/people" },
  { name: "person", path: (seed) => `/people/${seed.person.id}` },
  { name: "fields", path: () => "/fields" },
  { name: "videos", path: () => "/videos" },
  { name: "mailings", path: () => "/mailings" },
  { name: "mailing-new", path: () => "/mailings/new" },
  { name: "mailing-draft", path: (seed) => `/mailings/${seed.draft.id}` },
  { name: "mailing-report", path: (seed) => `/mailings/${seed.report.id}` },
  { name: "inbox", path: () => "/inbox" },
  // Лимиты, бюджет и ссылку на политику общей базы меняют проверки настроек и публикации
  { name: "settings", path: () => "/settings", mask: "main input" },
];

for (const screen of SCREENS) {
  test(`экран «${screen.name}» выглядит одинаково в светлой и тёмной теме`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const seed = await seedForShots(connection.db);
    await shoot(page, screen.path(seed), screen.name, screen.mask);
  });
}
