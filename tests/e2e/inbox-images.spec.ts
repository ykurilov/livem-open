import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDiskAttachmentStorage } from "@ykurilov/agent-chat-attachments";
import { expect, request as apiRequest, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots, outboundMessages } from "../../src/modules/channels/schema";
import { inboundMessages } from "../../src/modules/conversations/schema";
import { uploadsDir } from "../../src/modules/mailings/images";
import { people } from "../../src/modules/people/schema";
import { chatAttachmentsDir } from "../../src/modules/platform/chat-attachments";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";

/** Настоящий PNG 1×1: браузер должен его нарисовать, одного заголовка мало. */
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

let connection: DatabaseConnection;
const cleanup: string[] = [];

test.beforeAll(() => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
});

test.afterAll(async () => {
  await connection.close();
  await Promise.all(cleanup.map((path) => rm(path, { force: true })));
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

test("во «Входящих» видно фото клиента и картинку, которую отправил консультант; без входа картинка не отдаётся", async ({ page }) => {
  const { db } = connection;
  const tag = Date.now().toString(36);
  const token = `fake-photo${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот фото ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_photo${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  const name = `Фотограф ${tag}`;
  const [person] = await db.insert(people).values({ channel: "telegram", botId: bot!.id, externalUserId: `photo-${tag}`, displayName: name }).returning();

  // Фото уже во вложениях работника, как после хода консультанта; картинка консультанта — в папке загрузок
  const photo = PNG;
  const attachmentId = randomUUID();
  const workerDir = chatAttachmentsDir("worker");
  await createDiskAttachmentStorage({ directory: workerDir }).save(
    { id: attachmentId, chatId: "e2e", ownerId: "e2e", name: "photo.png", mediaType: "image/png", kind: "image", size: photo.byteLength, createdAt: new Date().toISOString(), attached: true },
    photo,
  );
  cleanup.push(join(workerDir, `${attachmentId}.bin`), join(workerDir, `${attachmentId}.json`));
  await mkdir(uploadsDir(), { recursive: true });
  const sentPath = join(uploadsDir(), `image-${randomUUID()}.png`);
  await writeFile(sentPath, PNG);
  cleanup.push(sentPath);

  const at = Date.now();
  const [inbound] = await db
    .insert(inboundMessages)
    .values({
      botId: bot!.id,
      kind: "message",
      dedupeKey: `photo:${tag}`,
      externalUserId: person!.externalUserId,
      text: "Вот мой экран",
      attachmentKind: "image",
      imageAttachmentId: attachmentId,
      personId: person!.id,
      route: "inbox",
      receivedAt: new Date(at - 60_000),
      processedAt: new Date(at - 60_000),
    })
    .returning();
  await db.insert(outboundMessages).values({
    botId: bot!.id,
    personId: person!.id,
    kind: "consultant",
    text: "Сравните со схемой",
    imagePath: sentPath,
    status: "sent",
    idempotencyKey: `photo-out:${tag}`,
    createdAt: new Date(at - 120_000),
  });

  await page.goto("/inbox");
  await page.getByRole("navigation", { name: "Неотвеченные" }).getByRole("link", { name: new RegExp(name) }).click();
  const messages = page.getByTestId("inbox-messages");
  await expect(messages).toContainText("Вот мой экран");
  await expect(messages).not.toContainText("[картинка]");
  for (const alt of ["Фото клиента", "Отправленная картинка"]) {
    const image = messages.getByRole("img", { name: alt });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
  }
  await expect(messages.getByRole("link", { name: "Фото клиента — открыть крупно" })).toHaveAttribute("href", `/api/inbox/images/in/${inbound!.id}`);

  const anonymous = await apiRequest.newContext({ baseURL: E2E_BASE_URL });
  expect((await anonymous.get(`/api/inbox/images/in/${inbound!.id}`)).status()).toBe(401);
  await anonymous.dispose();
});
