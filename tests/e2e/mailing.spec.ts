import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { and, eq, isNull } from "drizzle-orm";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots, outboundMessages } from "../../src/modules/channels/schema";
import { mailings } from "../../src/modules/mailings/schema";
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

/** Завтра в 18:00 по Москве — в виде поля `datetime-local`. */
function tomorrowAt18Msk(): string {
  const msk = new Date(Date.now() + 3 * 60 * 60_000 + 24 * 60 * 60_000);
  return `${msk.toISOString().slice(0, 10)}T18:00`;
}

test("эксперт создаёт рассылку, присылает себе пробу, планирует и отменяет", async ({ page }) => {
  test.setTimeout(90_000);
  const { db } = connection;
  // Свой ярлык у каждого прогона: при повторах и параллельных воркерах данные не пересекаются
  const tag = randomUUID().slice(0, 8);

  // Свой бот и люди — сразу в базе: приход людей через лидмагнит проверяют другие сценарии
  const token = `fake-mail${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот рассылок ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_mail${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  const myName = `Я эксперт ${tag}`;
  const [me] = await db.insert(people).values({ channel: "telegram", botId: bot!.id, externalUserId: `me-${tag}`, displayName: myName }).returning();
  await db.insert(people).values({ channel: "telegram", botId: bot!.id, externalUserId: `reader-${tag}`, displayName: `Читатель ${tag}` });

  await page.goto("/mailings");
  await page.getByRole("link", { name: "Новая рассылка" }).click();
  await expect(page).toHaveURL(/\/mailings\/new/);

  await page.getByRole("combobox", { name: "Бот" }).selectOption({ label: bot!.title });
  await page.getByRole("button", { name: "Показать" }).click();
  await expect(page.getByTestId("recipient-count")).toHaveText("Получателей: 2");

  const text = `Завтра эфир ${tag}: https://example.com/live`;
  await page.getByLabel("Текст").fill(text);
  // После неудачной отправки форма сбрасывает выбранный файл — подпись не врёт, что он ещё прикреплён
  const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  await page.getByLabel("Картинка").setInputFiles({ name: "обложка.png", mimeType: "image/png", buffer: tinyPng });
  await expect(page.getByText("обложка.png")).toBeVisible();
  await page.getByRole("button", { name: "Отправить себе" }).click();
  await expect(page.getByText("Выберите, кому прислать пробу")).toBeVisible();
  await expect(page.getByText("Файл не выбран")).toBeVisible();
  expect(await page.getByLabel("Картинка").evaluate((input: HTMLInputElement) => input.files?.length ?? 0)).toBe(0);
  await page.getByLabel("Текст").fill(text);
  // В базе e2e много людей: себя эксперт находит поиском по имени
  await page.getByLabel("Найти себя").fill(myName);
  await page.getByLabel("Найти себя").press("Enter");
  // Поиск срабатывает с задержкой, и список может обновиться прямо под курсором: выбор повторяется, пока не встанет
  const tester = page.getByRole("combobox", { name: "Кому прислать пробу" });
  await expect(async () => {
    await tester.selectOption(me!.id);
    await expect(tester).toHaveValue(me!.id, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByLabel("Картинка").setInputFiles({ name: "обложка.png", mimeType: "image/png", buffer: tinyPng });
  await page.getByRole("button", { name: "Отправить себе" }).click();

  // Сохранение, постановка пробы в очередь и первая сборка страницы рассылки под нагрузкой бывают дольше 5 секунд
  await expect(page).toHaveURL(/\/mailings\/[0-9a-f-]{36}\?done=test/, { timeout: 30_000 });
  await expect(page.getByText("Проба отправлена")).toBeVisible({ timeout: 15_000 });
  const mailingId = /\/mailings\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  // Проба ушла эксперту через работника и в рассылку не записана
  await expect
    .poll(
      async () =>
        (
          await db
            .select({ status: outboundMessages.status })
            .from(outboundMessages)
            .where(and(eq(outboundMessages.personId, me!.id), eq(outboundMessages.kind, "mailing"), isNull(outboundMessages.mailingId)))
        )[0]?.status,
      { timeout: 30_000 },
    )
    .toBe("sent");

  // Черновик помнит текст и фильтр
  await expect(page.getByLabel("Текст")).toHaveValue(text);
  await expect(page.getByTestId("recipient-count")).toHaveText("Получателей: 2");

  expect((await db.select().from(mailings).where(eq(mailings.id, mailingId)))[0]?.imagePath).toBeTruthy();
  const removeImage = page.getByRole("checkbox", { name: /Убрать прикреплённую картинку/ });
  await removeImage.check();
  await expect(removeImage).toBeChecked();
  await page.getByLabel("Время по Москве").fill(tomorrowAt18Msk());
  await page.getByRole("button", { name: "Запланировать" }).click();
  await expect(page.getByTestId("mailing-status")).toHaveText("Запланирована");
  await expect(page.getByText(/Уйдёт .* по Москве/)).toBeVisible();
  expect((await db.select().from(mailings).where(eq(mailings.id, mailingId)))[0]?.imagePath).toBeNull();

  await page.getByRole("button", { name: "Отменить" }).click();
  await expect(page.getByTestId("mailing-status")).toHaveText("Отменена");
  expect((await db.select().from(mailings).where(eq(mailings.id, mailingId)))[0]?.status).toBe("cancelled");
  expect(await db.select().from(outboundMessages).where(eq(outboundMessages.mailingId, mailingId))).toEqual([]);

  await page.goto("/mailings");
  await expect(page.getByRole("link", { name: new RegExp(`Завтра эфир ${tag}`) })).toBeVisible();
});
