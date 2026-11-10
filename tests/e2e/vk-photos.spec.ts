import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots } from "../../src/modules/channels/schema";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";

// Бот ВК без права «Фотографии»: пометка в списке ботов, объяснение и замена ключа в карточке, права в окне подключения.
// Подключение и отправку без права проверяют тесты адаптера и очереди с подделкой ВК
let connection: DatabaseConnection;
const SHOTS = process.env.VKPHOTOS_SHOTS_DIR;

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

test("бот ВК без права «Фотографии»: пометка в списке, объяснение и замена ключа в карточке, права в окне подключения", async ({ page }) => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const [bot] = await connection.db
    .insert(bots)
    .values({
      channel: "vk",
      title: `Клуб ${tag}`,
      externalId: String(Math.floor(Math.random() * 1e9)),
      username: `club_photos${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(`fake-vk-${tag}`),
      webhookSecret: `secret-${tag}`,
      canSendPhotos: false,
    })
    .returning();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/bots");
  const row = page.getByRole("row").filter({ hasText: `Клуб ${tag}` });
  await expect(row.getByText("Без картинок")).toBeVisible({ timeout: 60_000 });

  // Окно подключения ВК: права списком, у каждого — зачем
  await page.getByLabel("Мессенджер").selectOption({ label: "ВКонтакте" });
  const rights = page.getByRole("list", { name: "Права ключа" });
  await expect(rights.getByRole("listitem")).toHaveCount(3);
  await expect(rights.getByRole("listitem").nth(2)).toContainText("только если бот будет присылать картинки");
  if (SHOTS) {
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("list", { name: "Как подключить" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/vkphotos-connect-1440-light.png`, fullPage: true });
  }

  await page.goto(`/bots/${bot!.id}`);
  await expect(page.getByText("Бот не присылает картинки")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Новый ключ доступа сообщества")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/vkphotos-card-1440-light.png`, fullPage: true });

  // В сквозных проверках адаптера ВК нет (подделка только у Telegram): отказ виден эксперту, ключ бота не тронут
  await page.getByLabel("Новый ключ доступа сообщества").fill("не-ключ");
  await page.getByRole("button", { name: "Заменить ключ" }).click();
  await expect(page.getByText("Ключ не заменён")).toBeVisible({ timeout: 60_000 });

  if (SHOTS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(page.getByText("Бот не присылает картинки")).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SHOTS}/vkphotos-card-390-dark.png`, fullPage: true });
    await page.goto("/bots");
    await page.getByLabel("Мессенджер").selectOption({ label: "ВКонтакте" });
    await expect(page.getByRole("list", { name: "Права ключа" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/vkphotos-connect-390-dark.png`, fullPage: true });
  }
});
