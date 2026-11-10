// Картинки во «Входящих»: эксперт видит то же, что человек, — фото клиента и картинки, которые отправил бот.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAttachmentStorage, type AttachmentStorage } from "@ykurilov/agent-chat-attachments";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { FakeChannel } from "../channels/fake";
import { bots, outboundMessages } from "../channels/schema";
import { inboundMessages } from "../conversations/schema";
import { pngOf } from "../images/test-images";
import { people } from "../people/schema";
import { createTokenCipher } from "../platform/crypto";
import { inboxImageResponse, loadInboxThread, type InboxImageFiles } from "./index";

const cipher = createTokenCipher(Buffer.alloc(32, 7).toString("base64"));
const PNG = pngOf(2, 2);

let database: TestDatabase;
let uploads: string;
let clientImages: AttachmentStorage;
let channel: FakeChannel;
let files: InboxImageFiles;
let botId: string;
let personId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  uploads = await mkdtemp(join(tmpdir(), "inbox-images-"));
});

afterAll(async () => {
  await database.drop();
  await rm(uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  clientImages = createMemoryAttachmentStorage();
  channel = new FakeChannel();
  files = { clientImages, uploadsDir: uploads, messengers: { adapters: { telegram: channel }, cipher } };
  const tag = randomUUID().slice(0, 8);
  const [bot] = await database.db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот ${tag}`,
      externalId: `ext-${tag}`,
      username: `bot_${tag}`,
      tokenEncrypted: cipher.encrypt(`token-${tag}`),
      webhookSecret: `secret-${tag}`,
    })
    .returning();
  botId = bot!.id;
  const [person] = await database.db.insert(people).values({ channel: "telegram", botId, externalUserId: `user-${tag}`, displayName: "Аня" }).returning();
  personId = person!.id;
});

async function clientPhoto(fields: { text?: string; imageRef?: string; imageAttachmentId?: string }) {
  const [row] = await database.db
    .insert(inboundMessages)
    .values({
      botId,
      kind: "message",
      dedupeKey: `in:${randomUUID()}`,
      externalUserId: "user",
      personId,
      route: "inbox",
      attachmentKind: "image",
      text: fields.text ?? "",
      imageRef: fields.imageRef ?? null,
      imageAttachmentId: fields.imageAttachmentId ?? null,
      processedAt: new Date(),
    })
    .returning();
  return row!.id;
}

async function storedPhoto(): Promise<string> {
  const id = randomUUID();
  await clientImages.save(
    { id, chatId: "chat", ownerId: "owner", name: "file_1.png", mediaType: "image/png", kind: "image", size: PNG.byteLength, createdAt: new Date().toISOString(), attached: true },
    PNG,
  );
  return id;
}

async function sentWithImage(imagePath: string | null, text = "Вот схема") {
  const [row] = await database.db
    .insert(outboundMessages)
    .values({ botId, personId, kind: "consultant", text, imagePath, idempotencyKey: `out:${randomUUID()}` })
    .returning();
  return row!.id;
}

async function uploadedImage(name = `image-${randomUUID()}.png`): Promise<string> {
  const path = join(uploads, name);
  await writeFile(path, PNG);
  return path;
}

const thread = async () => (await loadInboxThread(database.db, personId, files))!;
const imageOf = async (id: string) => (await thread()).messages.find((message) => message.id === id)!;

describe("переписка отдаёт картинки", () => {
  it("фото клиента, которое видел консультант, — картинкой с адресом показа, без пометки «[картинка]»", async () => {
    const id = await clientPhoto({ text: "Вот мой экран", imageAttachmentId: await storedPhoto(), imageRef: "ref-1" });
    expect(await imageOf(id)).toMatchObject({ text: "Вот мой экран", image: { url: `/api/inbox/images/in/${id}` } });
  });

  it("фото, которое консультант не скачивал (разговор у эксперта), — тоже картинкой: скачается из мессенджера", async () => {
    const id = await clientPhoto({ imageRef: "ref-2" });
    expect((await imageOf(id)).image).toEqual({ url: `/api/inbox/images/in/${id}` });
  });

  it("фото удалено из вложений и ссылки нет — подпись вместо картинки", async () => {
    const id = await clientPhoto({ imageAttachmentId: randomUUID() });
    expect((await imageOf(id)).image).toEqual({ url: null });
  });

  it("картинка, которую отправил бот, — с первой частью исходящего; файл удалён — подпись", async () => {
    const shown = await sentWithImage(await uploadedImage());
    const mailing = await sentWithImage(await uploadedImage(`mailing-${randomUUID()}.png`));
    const removed = await sentWithImage(join(uploads, `image-${randomUUID()}.png`));
    const plain = await sentWithImage(null, "Без картинки");

    expect((await imageOf(shown)).image).toEqual({ url: `/api/inbox/images/out/${shown}` });
    expect((await imageOf(mailing)).image).toEqual({ url: `/api/inbox/images/out/${mailing}` });
    expect((await imageOf(removed)).image).toEqual({ url: null });
    expect((await imageOf(plain)).image).toBeNull();
  });
});

describe("адрес показа картинки", () => {
  const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

  it("отдаёт фото клиента из вложений, скачанное из мессенджера и картинку исходящего", async () => {
    const stored = await clientPhoto({ imageAttachmentId: await storedPhoto() });
    channel.serveImage("ref-3", { bytes: PNG, filename: "file_3", contentType: "application/octet-stream" });
    const downloaded = await clientPhoto({ imageRef: "ref-3" });
    const sent = await sentWithImage(await uploadedImage());

    for (const [direction, id] of [["in", stored], ["in", downloaded], ["out", sent]] as const) {
      const response = await inboxImageResponse(database.db, files, direction, id);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(await bytesOf(response)).toEqual(PNG);
    }
  });

  it("путь к файлу вне папки загрузок, ссылка, чужое имя, неизвестное сообщение — 404", async () => {
    const outside = join(tmpdir(), `image-${randomUUID()}.png`);
    await writeFile(outside, PNG);
    const cases = [
      ["out", await sentWithImage(outside)],
      ["out", await sentWithImage(join(uploads, "..", `image-${randomUUID()}.png`))],
      ["out", await sentWithImage(await uploadedImage("secret.png"))],
      ["out", await sentWithImage("https://example.com/image.png")],
      ["out", randomUUID()],
      ["in", randomUUID()],
      ["in", "../../etc/passwd"],
      ["other", await sentWithImage(await uploadedImage())],
    ] as const;
    for (const [direction, id] of cases) expect((await inboxImageResponse(database.db, files, direction, id)).status, `${direction}/${id}`).toBe(404);
    await rm(outside, { force: true });
  });

  it("мессенджер не отдал фото или отдал не картинку — 404", async () => {
    const missing = await clientPhoto({ imageRef: "ref-none" });
    channel.serveImage("ref-html", { bytes: new TextEncoder().encode("<html></html>"), filename: "x.html", contentType: "image/png" });
    const notImage = await clientPhoto({ imageRef: "ref-html" });
    expect((await inboxImageResponse(database.db, files, "in", missing)).status).toBe(404);
    expect((await inboxImageResponse(database.db, files, "in", notImage)).status).toBe(404);
  });
});
