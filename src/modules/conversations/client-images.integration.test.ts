// Фото и снимки экрана, которые человек шлёт в мессенджер: консультант видит их, только если лидмагнит их принимает.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, defaultConsultantReply, providerOutage, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import type { ScriptedCall } from "../platform/scripted-model";

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;

const PHOTO = "photo-ref-1";
const NOTE = "Его содержимое тебе недоступно";
/** Настоящий PNG 1×1: SDK читает картинку целиком, одного заголовка ему мало. */
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  person = `user-${randomUUID().slice(0, 8)}`;
  kit.channel.serveImage(PHOTO, { bytes: PNG, filename: "file_1.png", contentType: "image/png" });
});

/** Человек начал разговор и прислал фото; возвращает последний запрос к модели консультанта. */
async function sendPhoto(clientImages: boolean, caption = "Вот мой экран"): Promise<ScriptedCall> {
  const lead = await kit.publish({ clientImages });
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  await kit.send(person, caption, { attachment: "image", imageRef: PHOTO });
  await kit.drain();
  return kit.consultantCalls().at(-1)!;
}

/** Картинки в сообщениях человека в запросе модели. */
function imagePartsOf(call: ScriptedCall) {
  return call.options.prompt
    .filter((message) => message.role === "user")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === "file" && part.mediaType.startsWith("image/"));
}

describe("фото клиента в мессенджере", () => {
  it("настройка включена: фото — частью сообщения человека, без пометки «содержимое недоступно», ответ ушёл", async () => {
    const call = await sendPhoto(true);
    expect(kit.channel.imageDownloads).toEqual([PHOTO]);
    expect(imagePartsOf(call)).toHaveLength(1);
    expect(call.lastUserText).toContain("Вот мой экран");
    expect(call.lastUserText).not.toContain(NOTE);
    expect(kit.textsTo(person).length).toBeGreaterThanOrEqual(2);
  });

  it("включена: фото без подписи тоже доходит до модели", async () => {
    const call = await sendPhoto(true, "");
    expect(imagePartsOf(call)).toHaveLength(1);
    expect(call.lastUserText).not.toContain(NOTE);
  });

  it("включена: повтор хода после сбоя модели не скачивает фото второй раз и снова показывает его модели", async () => {
    let failed = false;
    kit.reply = (call) => {
      if (!failed && imagePartsOf(call).length > 0) {
        failed = true;
        throw providerOutage();
      }
      return defaultConsultantReply(call);
    };
    const call = await sendPhoto(true);
    expect(failed).toBe(true);
    expect(imagePartsOf(call)).toHaveLength(1);
    expect(kit.channel.imageDownloads).toEqual([PHOTO]);
    const [row] = (await kit.inboundOf(person)).filter((message) => message.imageRef === PHOTO);
    expect(row?.imageAttachmentId).toEqual(expect.any(String));
  });

  it("настройка выключена: фото не скачивается, модель видит прежнюю пометку о вложении", async () => {
    const call = await sendPhoto(false);
    expect(kit.channel.imageDownloads).toEqual([]);
    expect(imagePartsOf(call)).toHaveLength(0);
    expect(call.lastUserText).toContain(NOTE);
  });

  it("выключена: служба работника без вложений — в инструкции нет правил про вложения", async () => {
    const off = await sendPhoto(false);
    kit = await createLiveDialogKit(database);
    person = `user-${randomUUID().slice(0, 8)}`;
    kit.channel.serveImage(PHOTO, { bytes: PNG, filename: "file_1.png", contentType: "image/png" });
    const on = await sendPhoto(true);
    expect(on.system.length).toBeGreaterThan(off.system.length);
    expect(on.system.startsWith(off.system.slice(0, 200))).toBe(true);
  });

  it("включена, но фото не скачалось — ход идёт с прежней пометкой", async () => {
    kit.channel.serveImage(PHOTO, { ok: false, reason: "temporary", error: "Telegram недоступен" });
    const call = await sendPhoto(true);
    expect(kit.channel.imageDownloads).toEqual([PHOTO]);
    expect(imagePartsOf(call)).toHaveLength(0);
    expect(call.lastUserText).toContain(NOTE);
    expect(kit.textsTo(person).length).toBeGreaterThanOrEqual(2);
  });
});
