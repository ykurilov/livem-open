// Картинка, которую показал консультант, уходит фото с ответом-подписью в каждый из трёх мессенджеров — настоящими адаптерами.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import type { BotCredentials, ChannelAdapter } from "../channels/channel";
import { FakeMaxApi, maxError } from "../channels/max/fake-max-api";
import { createMaxAdapter } from "../channels/max/adapter";
import { bots, outboundMessages } from "../channels/schema";
import { enqueueOutbound, PHOTOS_NOT_ALLOWED_WARNING, sendOutbound, type OutboundDependencies } from "../channels/outbound";
import { FakeTelegramApi, telegramError } from "../channels/telegram/fake-telegram-api";
import { createTelegramAdapter } from "../channels/telegram/adapter";
import { FakeVkApi, vkError } from "../channels/vk/fake-vk-api";
import { createVkAdapter } from "../channels/vk/adapter";
import { createImage, imageUrl, sentImagePath, shownImagesOf, type ExpertImage } from "../images";
import { pngOf } from "../images/test-images";
import { createFakeClock } from "../platform/clock";

const bot: BotCredentials = { id: randomUUID(), token: "123456789:AA-secret", externalId: "222333", username: "live_magnet_bot", webhookSecret: "hook" };
const CAPTION = "Вот здесь ваше приложение — нажмите на него.";

let database: TestDatabase;
let uploads: string;
let image: ExpertImage;

beforeAll(async () => {
  database = await createTestDatabase();
  uploads = await mkdtemp(join(tmpdir(), "image-messengers-"));
  image = await createImage(database.db, { title: "Готовое приложение", description: "Где найти готовое приложение." }, { bytes: pngOf(1280, 720) }, uploads);
});

afterAll(async () => {
  await database.drop();
  await rm(uploads, { recursive: true, force: true });
});

/** Часть ответа консультанта после `show_image` — такой её пишет библиотека картинок SDK. */
const shownPart = () => ({
  type: "tool-show_image",
  state: "output-available",
  output: { картинка: { id: image.id, название: image.title, подпись: image.description, адрес: imageUrl(image.fileName), ширина: 1280, высота: 720 } },
});

/** Ответ консультанта с показанной картинкой — в очередь и в мессенджер через адаптер. */
async function deliver(adapter: ChannelAdapter, credentials: BotCredentials = bot) {
  const [shown] = shownImagesOf([shownPart()]);
  const dependencies: OutboundDependencies = {
    db: database.db,
    queue: { async enqueue() {} },
    clock: createFakeClock(new Date("2026-10-28T09:00:00Z")),
    async resolveTarget() {
      return { adapter, bot: credentials, to: "5550001" };
    },
    async onBlocked() {},
    async onPermanentFailure() {
      return "message";
    },
  };
  const { id } = await enqueueOutbound(dependencies, {
    botId: credentials.id,
    personId: randomUUID(),
    kind: "consultant",
    text: CAPTION,
    imagePath: sentImagePath(shown!, uploads),
    idempotencyKey: randomUUID(),
  });
  await sendOutbound(dependencies, id);
  const [row] = await database.db.select().from(outboundMessages).where(eq(outboundMessages.id, id));
  return row!;
}

describe("картинка консультанта в мессенджерах", () => {
  it("Telegram: одно фото из файла архива, ответ — подписью", async () => {
    const api = new FakeTelegramApi();
    await deliver(createTelegramAdapter({ fetch: api.fetch }));
    expect(api.requests.map((request) => request.method)).toEqual(["sendPhoto"]);
    const form = api.callsTo("sendPhoto")[0]!.body as FormData;
    expect(form.get("caption")).toBe(CAPTION);
    expect((form.get("photo") as File).name).toBe(image.fileName);
  });

  it("MAX: файл архива загружается, сообщение с картинкой и ответом", async () => {
    const api = new FakeMaxApi();
    await deliver(createMaxAdapter({ apiBaseUrl: "https://max-api.test", fetch: api.fetch }));
    expect((api.uploads[0]!.form.get("data") as File).name).toBe(image.fileName);
    expect(api.callsTo("POST /messages")).toHaveLength(1);
    expect(api.callsTo("POST /messages")[0]!.body).toMatchObject({ text: CAPTION, attachments: [{ type: "image" }] });
  });

  it("ВКонтакте: файл архива загружается фото, одно сообщение с вложением и ответом", async () => {
    const api = new FakeVkApi();
    await deliver(createVkAdapter({ apiBaseUrl: "https://vk-api.test", fetch: api.fetch }));
    expect((api.uploads[0]!.form.get("photo") as File).name).toBe(image.fileName);
    expect(api.callsTo("messages.send")).toHaveLength(1);
    expect(api.callsTo("messages.send")[0]!.params).toMatchObject({ message: CAPTION, attachment: expect.stringMatching(/^photo/) });
  });
});

describe("мессенджер не принял картинку — ответ всё равно доходит отдельным сообщением", () => {
  it("Telegram", async () => {
    const api = new FakeTelegramApi();
    api.replyOnce("sendPhoto", telegramError(400, "Bad Request: PHOTO_INVALID_DIMENSIONS"));
    const row = await deliver(createTelegramAdapter({ fetch: api.fetch }));
    expect(api.requests.map((request) => request.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(api.callsTo("sendMessage")[0]!.body).toMatchObject({ text: CAPTION });
    expect(row.status).toBe("sent");
  });

  it("MAX", async () => {
    const api = new FakeMaxApi();
    api.replyToUploadOnce(maxError(400, "file.too.big"));
    const row = await deliver(createMaxAdapter({ apiBaseUrl: "https://max-api.test", fetch: api.fetch }));
    expect(api.callsTo("POST /messages")).toHaveLength(1);
    expect(api.callsTo("POST /messages")[0]!.body).toMatchObject({ text: CAPTION });
    expect(api.callsTo("POST /messages")[0]!.body).not.toHaveProperty("attachments");
    expect(row.status).toBe("sent");
  });

  it("ВКонтакте", async () => {
    const api = new FakeVkApi();
    api.replyToUploadOnce({ status: 200, body: { server: 999001, photo: "[]", hash: "h4sh" } });
    const row = await deliver(createVkAdapter({ apiBaseUrl: "https://vk-api.test", fetch: api.fetch }));
    expect(api.callsTo("messages.send")).toHaveLength(1);
    expect(api.callsTo("messages.send")[0]!.params).toMatchObject({ message: CAPTION });
    expect(api.callsTo("messages.send")[0]!.params).not.toHaveProperty("attachment");
    expect(row.status).toBe("sent");
  });
});

describe("ВКонтакте: у ключа нет права «Фотографии» — ответ уходит текстом, эксперт видит предупреждение", () => {
  it("бот уже помечен как без картинок: картинку не загружаем, текст уходит, сбоя нет", async () => {
    const api = new FakeVkApi();
    const row = await deliver(createVkAdapter({ apiBaseUrl: "https://vk-api.test", fetch: api.fetch }), { ...bot, canSendPhotos: false });
    expect(api.uploads).toHaveLength(0);
    expect(api.callsTo("photos.getMessagesUploadServer")).toHaveLength(0);
    expect(api.callsTo("messages.send")).toHaveLength(1);
    expect(api.callsTo("messages.send")[0]!.params).toMatchObject({ message: CAPTION });
    expect(api.callsTo("messages.send")[0]!.params).not.toHaveProperty("attachment");
    expect(row).toMatchObject({ status: "sent", error: null, imagePath: null, imageNotSent: PHOTOS_NOT_ALLOWED_WARNING });
  });

  it("признак устарел: ВК отказал в фото — текст уходит, бот запоминает, что картинок у него нет", async () => {
    const stale = await insertVkBot();
    const api = new FakeVkApi();
    api.replyOnce("photos.getMessagesUploadServer", vkError(15, "Access denied: no access to call this method"));
    const row = await deliver(createVkAdapter({ apiBaseUrl: "https://vk-api.test", fetch: api.fetch }), stale);
    expect(api.callsTo("messages.send")).toHaveLength(1);
    expect(api.callsTo("messages.send")[0]!.params).toMatchObject({ message: CAPTION });
    expect(api.callsTo("messages.send")[0]!.params).not.toHaveProperty("attachment");
    expect(row).toMatchObject({ status: "sent", imagePath: null, imageNotSent: PHOTOS_NOT_ALLOWED_WARNING });
    const [saved] = await database.db.select({ canSendPhotos: bots.canSendPhotos }).from(bots).where(eq(bots.id, stale.id));
    expect(saved?.canSendPhotos).toBe(false);
  });

  it("ключ с правом: картинка уходит как раньше, предупреждения нет", async () => {
    const api = new FakeVkApi();
    const row = await deliver(createVkAdapter({ apiBaseUrl: "https://vk-api.test", fetch: api.fetch }), { ...bot, canSendPhotos: true });
    expect(api.callsTo("messages.send")[0]!.params).toMatchObject({ message: CAPTION, attachment: expect.stringMatching(/^photo/) });
    expect(row).toMatchObject({ status: "sent", imageNotSent: null });
    expect(row.imagePath).not.toBeNull();
  });
});

async function insertVkBot(): Promise<BotCredentials> {
  const id = randomUUID();
  await database.db.insert(bots).values({
    id,
    channel: "vk",
    title: "Сообщество",
    externalId: String(Math.floor(Math.random() * 1e9)),
    username: `club_${id.slice(0, 8)}`,
    tokenEncrypted: "sealed",
    webhookSecret: "hook",
  });
  return { ...bot, id, canSendPhotos: true };
}
