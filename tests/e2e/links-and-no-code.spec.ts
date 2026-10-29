import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots, outboundMessages } from "../../src/modules/channels/schema";
import { passages } from "../../src/modules/conversations/schema";
import { attachBot, createLeadMagnet, publishLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { people } from "../../src/modules/people/schema";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, FRESH_CONNECTION } from "./e2e-env";

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

test("ссылка с меткой попадает в отчёт; бот в режиме «меню» после снятия с публикации показывает кнопки", async ({ page, request, context }) => {
  test.setTimeout(180_000);
  const { db } = connection;
  // Своя приставка ключей: соседний тест публикации тоже шлёт `e2e:<время>:N`, а ключ повтора общий для всех ботов
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  await page.goto("/bots");
  await page.getByLabel("Токен бота").fill(`fake-links${tag}`);
  await page.getByRole("button", { name: "Подключить" }).click();
  await expect(page.getByText("Бот подключён")).toBeVisible({ timeout: 60_000 });
  const [bot] = await db.select().from(bots).where(eq(bots.username, `bot_links${tag}`));

  const publish = async (name: string) => {
    const lead = await createLeadMagnet(db, { name });
    await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
    await attachBot(db, { leadMagnetId: lead.id, botId: bot!.id });
    return { id: lead.id, ...(await publishLeadMagnet(db, lead.id)) };
  };
  const main = await publish(`Основной ${tag}`);
  const other = await publish(`Второй ${tag}`);

  // Ссылка с меткой
  await page.goto(`/lead-magnets/${main.id}/publish`);
  const advertising = page.getByRole("list", { name: "Примеры рекламных ссылок" });
  const example = `https://fake.test/${bot!.username}?start=${main.code}__ad_campaign__video_01`;
  await expect(advertising.getByText(example, { exact: true })).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await advertising.getByRole("button", { name: "Копировать · Telegram" }).click();
  await expect(advertising.getByRole("button", { name: "Скопировано" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(example);
  await expect(page.getByRole("columnheader", { name: "Начали разговор" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Расход ИИ", exact: true })).toBeVisible();
  await page.getByLabel("Метка новой ссылки").fill("Блогер Маша");
  await page.getByRole("button", { name: "Новая ссылка" }).click();
  const labeled = page.getByTestId("labeled-link-telegram");
  await expect(labeled).toBeVisible({ timeout: 30_000 });
  const code = /start=([A-Za-z0-9]{8})$/.exec((await labeled.textContent()) ?? "")?.[1];
  expect(code).toBeDefined();

  let update = 0;
  const send = async (userId: string, event: Record<string, unknown>) => {
    const response = await request.post(`/api/webhooks/telegram/${bot!.id}`, {
      headers: { ...FRESH_CONNECTION, "x-fake-secret": bot!.webhookSecret },
      data: { events: [{ dedupeKey: `e2e-links:${tag}:${++update}`, userId, ...event }] },
    });
    expect(response.status()).toBe(200);
  };
  const passagesOf = async (userId: string) => {
    const [person] = await db.select().from(people).where(and(eq(people.externalUserId, userId), eq(people.botId, bot!.id)));
    return person ? db.select().from(passages).where(eq(passages.personId, person.id)) : [];
  };

  const masha = `masha-${tag}`;
  await send(masha, { type: "message", text: `/start ${code}`, startCode: code });
  await expect.poll(async () => (await passagesOf(masha)).length, { timeout: 30_000 }).toBe(1);

  await page.reload();
  const reportRow = page.getByRole("row", { name: /Блогер Маша/ });
  await expect(reportRow.getByRole("cell").nth(1)).toHaveText("1");

  // Режим «меню» на экране бота; удалить бота с опубликованными нельзя
  await page.goto(`/bots/${bot!.id}`);
  await page.getByRole("combobox", { name: "Что делает бот без кода" }).selectOption({ label: "Меню" });
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Удалить бота" }).click();
  await expect(page.getByText(/снимите с публикации/).last()).toBeVisible({ timeout: 30_000 });

  // Снятие с публикации: ссылка ведёт в меню бота, где остался только второй лидмагнит
  await page.goto(`/lead-magnets/${main.id}/publish`);
  await page.getByRole("button", { name: "Снять с публикации" }).click();
  await expect(page.getByText("Черновик", { exact: true })).toBeVisible({ timeout: 30_000 });

  const late = `late-${tag}`;
  await send(late, { type: "message", text: `/start ${code}`, startCode: code });
  const menuOf = async () => {
    const [person] = await db.select().from(people).where(and(eq(people.externalUserId, late), eq(people.botId, bot!.id)));
    if (!person) return null;
    const [menu] = await db
      .select()
      .from(outboundMessages)
      .where(and(eq(outboundMessages.personId, person.id), eq(outboundMessages.kind, "menu"), eq(outboundMessages.status, "sent")));
    return menu?.buttons ?? null;
  };
  await expect.poll(menuOf, { timeout: 30_000 }).toEqual([{ label: `Второй ${tag}`, payload: `start:${other.code}` }]);

  // Нажатие кнопки запускает выбранный лидмагнит
  await send(late, { type: "button", callbackId: `cb-${tag}`, payload: `start:${other.code}` });
  await expect.poll(async () => (await passagesOf(late)).map((passage) => passage.leadMagnetId), { timeout: 30_000 }).toEqual([other.id]);
});
