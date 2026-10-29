import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { BASE_SETTINGS, createLiveDialogKit, outboundOf, providerOutage, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { createImage, deleteImage, type ExpertImage } from "../images";
import { pngOf } from "../images/test-images";
import { loadPersonCard } from "../people";

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;
let uploads: string;
let previousUploads: string | undefined;
let allowed: ExpertImage;
let forbidden: ExpertImage;
let second: ExpertImage;

const file = { bytes: pngOf(1280, 720) };

beforeAll(async () => {
  database = await createTestDatabase();
  uploads = await mkdtemp(join(tmpdir(), "consultant-images-"));
  previousUploads = process.env.UPLOADS_DIR;
  process.env.UPLOADS_DIR = uploads;
  allowed = await createImage(database.db, { title: "Готовое приложение", description: "Где найти готовое приложение: кнопка слева." }, file, uploads);
  forbidden = await createImage(database.db, { title: "Секретный экран", description: "Не для этого лидмагнита." }, file, uploads);
  second = await createImage(database.db, { title: "Редактор", description: "Где редактор приложения." }, file, uploads);
});

afterAll(async () => {
  if (previousUploads === undefined) delete process.env.UPLOADS_DIR;
  else process.env.UPLOADS_DIR = previousUploads;
  await database.drop();
  await rm(uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  person = `user-${randomUUID().slice(0, 8)}`;
});

const REPLY = "Вот здесь ваше приложение — нажмите на него.";
const FAREWELL = BASE_SETTINGS.farewellMessage!;

/** Сообщения человеку после старта: текст и путь к картинке, если она была. */
async function talk(imageIds: string[], text: string, beforeQuestion?: () => void) {
  const lead = await kit.publish({ imageIds });
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  const before = kit.channel.messagesTo(person).length;
  beforeQuestion?.();
  await kit.send(person, text);
  await kit.drain();
  return sentAfter(before);
}

function sentAfter(before: number) {
  return kit.channel.messagesTo(person).slice(before).map(({ message }) => ({ text: message.text, imagePath: message.imagePath ?? null }));
}

/** Модель показывает картинку и потом отвечает текстом. */
function showing(ids: string[], { finish = false } = {}) {
  kit.reply = (call) => {
    if (call.lastToolResult !== undefined) return { text: REPLY };
    return {
      toolCalls: [
        ...ids.map((id) => ({ toolName: "show_image", input: { id } })),
        ...(finish ? [{ toolName: "finish_dialog", input: { goal: "Цель", stuckAt: "Застрял", chosenStep: "Созвон", outcome: "agreed" } }] : []),
      ],
    };
  };
}

const pathOf = (image: ExpertImage) => join(uploads, image.fileName);

describe("картинки консультанта в мессенджере", () => {
  it("без разрешённых картинок инструментов картинок нет, и правила про картинки в инструкции нет", async () => {
    await talk([], "Привет");
    expect(kit.calls[0]!.toolNames).not.toContain("show_image");
    expect(kit.calls[0]!.toolNames).not.toContain("find_images");
    expect(kit.calls[0]!.system).not.toContain("show_image");
  });

  it("с разрешёнными картинками есть инструменты и правило, но списка картинок в инструкции нет", async () => {
    await talk([allowed.id], "Привет");
    expect(kit.calls[0]!.toolNames).toEqual(expect.arrayContaining(["find_images", "show_image"]));
    expect(kit.calls[0]!.system).toContain("show_image");
    expect(kit.calls[0]!.system).not.toContain(allowed.title);
  });

  it("все разрешённые картинки удалены из архива — у консультанта картинок нет: ни инструментов, ни правила", async () => {
    const gone = await createImage(database.db, { title: "Удалённая", description: "Была и нет." }, file, uploads);
    await deleteImage(database.db, gone.id, new Date());
    await talk([gone.id], "Привет");
    expect(kit.calls[0]!.toolNames).not.toContain("show_image");
    expect(kit.calls[0]!.system).not.toContain("show_image");
  });

  it("показанная картинка уходит фото с ответом в подписи: файл из архива", async () => {
    showing([allowed.id]);
    expect(await talk([allowed.id], "Где моё приложение?")).toEqual([{ text: REPLY, imagePath: pathOf(allowed) }]);
    expect((await outboundOf(kit)).filter((row) => row.imagePath)).toHaveLength(1);
  });

  it("разговор завершён с согласием в том же ходе: картинка с прощанием, свой текст модели не уходит", async () => {
    showing([allowed.id], { finish: true });
    const sent = await talk([allowed.id], "Где моё приложение?");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.imagePath).toBe(pathOf(allowed));
    expect(sent[0]!.text).toContain(FAREWELL);
    expect(sent[0]!.text).not.toContain(REPLY);
  });

  it("ход упал после показа картинки — повтор не даёт дубля", async () => {
    let failed = false;
    kit.reply = (call) => {
      if (call.lastToolResult === undefined && !failed) return { toolCalls: [{ toolName: "show_image", input: { id: allowed.id } }] };
      if (!failed) {
        failed = true;
        throw providerOutage();
      }
      return { text: REPLY };
    };
    expect(await talk([allowed.id], "Где моё приложение?")).toEqual([{ text: REPLY, imagePath: pathOf(allowed) }]);
    expect((await outboundOf(kit)).filter((row) => row.imagePath)).toHaveLength(1);
  });

  it("две картинки за ответ — человеку уходит только первая", async () => {
    showing([allowed.id, second.id]);
    expect(await talk([allowed.id, second.id], "Где моё приложение?")).toEqual([{ text: REPLY, imagePath: pathOf(allowed) }]);
  });

  it("картинка, уже показанная в разговоре, второй раз не уходит", async () => {
    showing([allowed.id]);
    await talk([allowed.id], "Где моё приложение?");
    const before = kit.channel.messagesTo(person).length;
    await kit.send(person, "А покажи ещё раз?");
    await kit.drain();
    expect(sentAfter(before)).toEqual([{ text: REPLY, imagePath: null }]);
  });

  it("картинка, не разрешённая лидмагниту, не уходит", async () => {
    showing([forbidden.id]);
    expect(await talk([allowed.id], "Покажи секретный экран")).toEqual([{ text: REPLY, imagePath: null }]);
    expect(kit.calls.at(-1)!.lastToolResult).toMatchObject({ type: "error-text", value: expect.stringContaining("ImageLibraryError") });
  });

  it("карточка человека показывает картинку названием, а не текстом инструмента", async () => {
    showing([allowed.id]);
    await talk([allowed.id], "Где моё приложение?");
    const owner = await kit.personOf(person);
    const card = await loadPersonCard({ db: kit.db, chatStorage: kit.chatStorage }, owner!.id);
    expect(card!.passages[0]!.messages.slice(-2)).toEqual([
      { role: "assistant", text: REPLY },
      { role: "assistant", text: "🖼 Готовое приложение", image: { title: "Готовое приложение", url: `/api/images/${allowed.fileName}` } },
    ]);
  });
});
