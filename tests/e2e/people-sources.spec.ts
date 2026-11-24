import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { passages } from "../../src/modules/conversations/schema";
import { createLabeledLink, createLeadMagnet, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
import { people } from "../../src/modules/people/schema";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";

/** Снимки экрана для отчёта; эталонами не сравниваются — данные других тестов в общей базе меняют список лидмагнитов. */
const SHOTS_DIR = "test-results/people-sources-shots";

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

/** Свой бот, опубликованный лидмагнит, две метки и люди — сразу в базе: приход по ссылке проверяют другие сценарии. */
async function seed(tag: string) {
  const { db } = connection;
  const token = `fake-sources${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот источников ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_sources${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  const leadName = `Источники ${tag}`;
  const lead = await createLeadMagnet(db, { name: leadName });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
  const { snapshotId } = await publishWithBots(db, lead.id, { telegram: bot!.id });
  const blogger = await createLabeledLink(db, { leadMagnetId: lead.id, label: `блогер_${tag}` });
  const silent = await createLabeledLink(db, { leadMagnetId: lead.id, label: `тишина_${tag}` });

  const arrive = async (entryLinkId: string, outcome: { status?: "completed"; purchased?: boolean } = {}) => {
    const [person] = await db
      .insert(people)
      .values({ channel: "telegram", botId: bot!.id, externalUserId: `src-${randomUUID()}`, displayName: `Гость ${tag}` })
      .returning();
    await db.insert(passages).values({
      personId: person!.id,
      leadMagnetId: lead.id,
      snapshotId,
      entryLinkId,
      chatId: randomUUID(),
      status: outcome.status ?? "active",
      costUsd: "0.12",
      purchasedAt: outcome.purchased ? new Date() : null,
    });
  };
  await arrive(blogger.id, { status: "completed", purchased: true });
  await arrive(blogger.id, { status: "completed" });
  await arrive(blogger.id);
  return { leadId: lead.id, leadName, blogger: blogger.label!, silent: silent.label! };
}

test("эксперт видит, какая метка привела людей, и открывает их список", async ({ page }) => {
  test.setTimeout(120_000);
  const tag = Date.now().toString(36);
  const seeded = await seed(tag);

  await page.goto("/people");
  // Вкладка переходит по клику только после загрузки скриптов страницы: до неё клик повторяется
  await expect(async () => {
    await page.getByRole("tab", { name: "Откуда пришли" }).click();
    await expect(page).toHaveURL(/\/people\/sources$/, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole("tab", { name: "Откуда пришли" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("combobox", { name: "Лидмагнит" }).selectOption({ label: seeded.leadName });
  await expect(page).toHaveURL(new RegExp(`lead=${seeded.leadId}`));
  await expect(page.getByTestId("sources-filter")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("sources-arrived")).toContainText("3");
  await expect(page.getByTestId("sources-purchased")).toContainText("1");
  await expect(page.getByText("Людей пока мало — сравнивать источники рано.")).toBeVisible();

  const bloggerRow = page.getByRole("row").filter({ hasText: seeded.blogger });
  await expect(bloggerRow).toContainText("$");
  const silentRow = page.getByRole("row").filter({ hasText: seeded.silent });
  await expect(silentRow).toBeVisible();

  await page.getByRole("combobox", { name: "Период" }).selectOption({ label: "Всё время" });
  await expect(page).toHaveURL(/period=all/);
  // Отчёт за новый период ещё грузится, пока фильтр занят: снимок и переход — после
  await expect(page.getByTestId("sources-filter")).toHaveAttribute("aria-busy", "false");

  // Тема ставится при загрузке страницы: после смены — перезагрузка. Значок разработки Next.js в углу — не часть кабинета
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.reload();
    await expect(page.getByTestId("sources-arrived")).toContainText("3");
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.screenshot({ path: `${SHOTS_DIR}/stats-${colorScheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();

  await bloggerRow.getByRole("link", { name: new RegExp(`Люди: ${seeded.blogger}, 3`) }).click();
  await expect(page).toHaveURL(/\/people\?arrivedLead=/);
  await expect(page.getByTestId("people-count")).toHaveText("Найдено: 3");
  await expect(page.getByTestId("people-arrival")).toContainText(`по метке «${seeded.blogger}»`);
});

test.describe("на телефоне", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("таблица источников становится карточками", async ({ page }) => {
    const tag = `m${Date.now().toString(36)}`;
    const seeded = await seed(tag);
    await page.goto(`/people/sources?period=all&lead=${seeded.leadId}`);
    await expect(page.getByText(seeded.blogger)).toBeVisible();
    await expect(page.getByTestId("sources-arrived")).toContainText("3");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.screenshot({ path: `${SHOTS_DIR}/stats-phone.png`, fullPage: true });
  });
});
