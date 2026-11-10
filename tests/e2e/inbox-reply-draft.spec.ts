import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { inboundMessages } from "../../src/modules/conversations/schema";
import { people } from "../../src/modules/people/schema";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";

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

/** Бот и люди с неотвеченным вопросом каждый; время последнего сообщения у всех одно. */
async function seedThreads(names: (tag: string) => string[]) {
  const { db } = connection;
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const token = `fake-draft${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот черновика ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_draft${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  const persons = await db
    .insert(people)
    .values(names(tag).map((displayName, index) => ({ channel: "telegram" as const, botId: bot!.id, externalUserId: `draft-${tag}-${index}`, displayName })))
    .returning();
  const at = new Date();
  await db.insert(inboundMessages).values(
    persons.map((person, index) => ({
      botId: bot!.id,
      kind: "message" as const,
      dedupeKey: `draft:${tag}:${index}`,
      externalUserId: person.externalUserId,
      text: `Вопрос от ${person.displayName}`,
      personId: person.id,
      route: "inbox" as const,
      receivedAt: at,
      processedAt: at,
    })),
  );
  return persons;
}

test("черновик ответа не переходит к другому собеседнику, даже если их сообщения пришли в одну и ту же секунду", async ({ page }) => {
  const persons = await seedThreads((tag) => [`Аня ${tag}`, `Боря ${tag}`]);
  const names = persons.map((person) => person.displayName!);

  const threads = page.getByRole("navigation", { name: "Неотвеченные" });
  await page.goto("/inbox");
  await threads.getByRole("link", { name: new RegExp(names[0]!) }).click();
  await expect(page.getByTestId("inbox-messages")).toContainText(`Вопрос от ${names[0]}`);
  await page.getByLabel("Ваш ответ").fill("Черновик для Ани");

  await threads.getByRole("link", { name: new RegExp(names[1]!) }).click();
  await expect(page.getByTestId("inbox-messages")).toContainText(`Вопрос от ${names[1]}`);
  await expect(page.getByLabel("Ваш ответ")).toHaveValue("");
});

test("успех ответа не стирает то, что эксперт начал печатать, пока ответ уходил", async ({ page }) => {
  const [person] = await seedThreads((tag) => [`Вера ${tag}`]);
  // Ответ держится в пути, пока тест не отпустит: за это время эксперт пишет следующий
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let replying = false;
  await page.route(/\/inbox\?/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    replying = true;
    await held;
    await route.continue();
  });

  await page.goto(`/inbox?person=${person!.id}`);
  const field = page.getByLabel("Ваш ответ");
  await field.fill("Первый ответ");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect.poll(() => replying).toBe(true);
  await field.fill("Следующий, пока первый уходил");
  release();

  await expect(page.getByTestId("inbox-messages")).toContainText("Первый ответ");
  await expect(field).toHaveValue("Следующий, пока первый уходил");
});

test("на телефоне выбранная переписка открывается вместо списка, «Назад» возвращает к списку", async ({ page }) => {
  const [person] = await seedThreads((tag) => [`Галя ${tag}`]);
  const name = person!.displayName!;
  await page.setViewportSize({ width: 390, height: 844 });

  const threads = page.getByRole("navigation", { name: "Неотвеченные" });
  await page.goto("/inbox");
  await expect(page.getByText("Выберите переписку слева")).toBeHidden();
  await threads.getByRole("link", { name: new RegExp(name) }).click();
  await expect(page.getByTestId("inbox-messages")).toContainText(`Вопрос от ${name}`);
  await expect(threads).toBeHidden();
  await expect(page.getByLabel("Ваш ответ")).toBeInViewport();

  await page.getByRole("link", { name: "Все переписки" }).click();
  await expect(threads.getByRole("link", { name: new RegExp(name) })).toBeVisible();
});

test("новое сообщение появляется во «Входящих» само, не стирает набранный ответ и после него остаётся неотвеченным", async ({ page }) => {
  test.setTimeout(90_000);
  const [person] = await seedThreads((tag) => [`Дина ${tag}`]);
  await page.goto(`/inbox?person=${person!.id}`);
  const field = page.getByLabel("Ваш ответ");
  await field.fill("Пишу ответ");

  const at = new Date();
  await connection.db.insert(inboundMessages).values({
    botId: person!.botId,
    kind: "message",
    dedupeKey: `draft:new:${person!.id}`,
    externalUserId: person!.externalUserId,
    text: `Ещё вопрос от ${person!.displayName}`,
    personId: person!.id,
    route: "inbox",
    receivedAt: at,
    processedAt: at,
  });

  await expect(page.getByTestId("inbox-messages")).toContainText(`Ещё вопрос от ${person!.displayName}`, { timeout: 40_000 });
  await expect(field).toHaveValue("Пишу ответ");
  await expect(field).toBeFocused();

  // Ответ начат до нового вопроса: вопрос, пришедший за это время, ждёт своего ответа
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.getByTestId("inbox-messages")).toContainText("Пишу ответ");
  await page.goto("/inbox");
  await expect(page.getByRole("navigation", { name: "Неотвеченные" }).getByRole("link", { name: new RegExp(person!.displayName!) })).toBeVisible();
});
