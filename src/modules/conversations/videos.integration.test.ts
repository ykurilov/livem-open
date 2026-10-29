import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { BASE_SETTINGS, createLiveDialogKit, outboundOf, providerOutage, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { loadInboxThread } from "../inbox";
import { loadPersonCard } from "../people";
import { createVideo, deleteVideo, type Video } from "../videos";

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;
let allowed: Video;
let forbidden: Video;
let second: Video;

beforeAll(async () => {
  database = await createTestDatabase();
  allowed = await createVideo(database.db, {
    title: "Упаковка экспертизы",
    url: "https://www.youtube.com/watch?v=aircAruvnKk",
    description: "Как описать, что вы делаете.",
    durationSeconds: 600,
  });
  forbidden = await createVideo(database.db, {
    title: "Секретный ролик",
    url: "https://kinescope.io/secret1",
    description: "Не для этого лидмагнита.",
  });
  second = await createVideo(database.db, { title: "Цены на услуги", url: "https://kinescope.io/prices1", description: "Как назначить цену." });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  person = `user-${randomUUID().slice(0, 8)}`;
});

const REPLY = "Посмотрите ролик — там как раз про это.";
const VIDEO_TEXT = "▶ Упаковка экспертизы\nс 3:20\nhttps://www.youtube.com/watch?v=aircAruvnKk&t=200s";
const FAREWELL = BASE_SETTINGS.farewellMessage!;

async function talk(videoIds: string[], text: string, beforeQuestion?: () => void) {
  const lead = await kit.publish({ videoIds });
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  const before = kit.textsTo(person).length;
  beforeQuestion?.();
  await kit.send(person, text);
  await kit.drain();
  return kit.textsTo(person).slice(before);
}

/** Модель показывает ролик и потом отвечает текстом. */
function showing(id: string, startSeconds?: number, { finish = false } = {}) {
  kit.reply = (call) => {
    if (call.lastToolResult !== undefined) return { text: REPLY };
    return {
      toolCalls: [
        { toolName: "show_video", input: { id, ...(startSeconds !== undefined && { startSeconds }) } },
        ...(finish ? [{ toolName: "finish_dialog", input: { goal: "Цель", stuckAt: "Застрял", chosenStep: "Созвон", outcome: "agreed" } }] : []),
      ],
    };
  };
}

describe("видео консультанта в мессенджере", () => {
  it("без разрешённых роликов инструментов видео нет, и правила про видео в инструкции нет", async () => {
    await talk([], "Привет");
    expect(kit.calls[0]!.toolNames).not.toContain("show_video");
    expect(kit.calls[0]!.toolNames).not.toContain("find_videos");
    expect(kit.calls[0]!.system).not.toContain("show_video");
  });

  it("с разрешёнными роликами есть инструменты и правило, но списка роликов в инструкции нет", async () => {
    await talk([allowed.id], "Привет");
    expect(kit.calls[0]!.toolNames).toEqual(expect.arrayContaining(["find_videos", "show_video"]));
    expect(kit.calls[0]!.system).toContain("show_video");
    expect(kit.calls[0]!.system).not.toContain(allowed.title);
  });

  it("все разрешённые ролики удалены из архива — у консультанта видео нет: ни инструментов, ни правила", async () => {
    const gone = await createVideo(database.db, { title: "Удалённый", url: "https://kinescope.io/gone1", description: "Был и нет." });
    await deleteVideo(database.db, gone.id, new Date());
    await talk([gone.id], "Привет");
    expect(kit.calls[0]!.toolNames).not.toContain("show_video");
    expect(kit.calls[0]!.toolNames).not.toContain("find_videos");
    expect(kit.calls[0]!.system).not.toContain("show_video");
  });

  it("ролик удалили после показа — разговор идёт дальше, «Входящие» и карточка целы", async () => {
    const doomed = await createVideo(database.db, { title: "Скоро удалим", url: "https://kinescope.io/doomed1", description: "Временный." });
    kit.reply = (call) =>
      call.lastToolResult !== undefined || !call.toolNames.includes("show_video")
        ? { text: REPLY }
        : { toolCalls: [{ toolName: "show_video", input: { id: doomed.id } }] };
    await talk([doomed.id], "Покажи ролик");
    await deleteVideo(database.db, doomed.id, new Date());

    const before = kit.textsTo(person).length;
    await kit.send(person, "Спасибо, а дальше?");
    await kit.drain();
    expect(kit.textsTo(person).slice(before)).toEqual([REPLY]);
    expect(kit.calls.at(-1)!.toolNames).not.toContain("show_video");

    const link = { title: "Скоро удалим", url: "https://kinescope.io/doomed1" };
    const owner = await kit.personOf(person);
    const thread = await loadInboxThread(kit.db, owner!.id);
    expect(thread!.messages.filter((message) => message.video).map((message) => message.video)).toEqual([link]);
    const card = await loadPersonCard({ db: kit.db, chatStorage: kit.chatStorage }, owner!.id);
    expect(card!.passages[0]!.messages.filter((message) => message.video).map((message) => message.video)).toEqual([link]);
  });

  it("показанный ролик уходит отдельным сообщением после ответа: название, «с 3:20», ссылка с отметкой времени", async () => {
    showing(allowed.id, 200);
    const sent = await talk([allowed.id], "Как упаковать экспертизу?");
    expect(sent).toEqual([
      "Посмотрите ролик — там как раз про это.",
      "▶ Упаковка экспертизы\nс 3:20\nhttps://www.youtube.com/watch?v=aircAruvnKk&t=200s",
    ]);
    const rows = await outboundOf(kit);
    expect(rows.find((row) => row.video)?.video).toEqual({
      title: "Упаковка экспертизы",
      url: "https://www.youtube.com/watch?v=aircAruvnKk&t=200s",
      startLabel: "3:20",
    });
  });

  it("первая отправка ответа не удалась — при повторе порядок тот же: ответ, потом ролик", async () => {
    showing(allowed.id, 200);
    const sent = await talk([allowed.id], "Как упаковать экспертизу?", () =>
      kit.channel.failNext({ ok: false, reason: "temporary", error: "Сеть моргнула" }),
    );
    expect(sent).toEqual([REPLY, VIDEO_TEXT]);
  });

  it("разговор завершён с согласием в том же ходе: ролик, потом прощание; свой текст модели не уходит, пустых сообщений нет", async () => {
    showing(allowed.id, 200, { finish: true });
    const sent = await talk([allowed.id], "Как упаковать экспертизу?");
    expect(sent).toEqual([VIDEO_TEXT, FAREWELL]);
    expect((await kit.passagesOf(person)).at(-1)!.status).toBe("completed");
  });

  it("ход упал после показа ролика — повтор не даёт дубля", async () => {
    let failed = false;
    kit.reply = (call) => {
      if (call.lastToolResult === undefined && !failed) return { toolCalls: [{ toolName: "show_video", input: { id: allowed.id, startSeconds: 200 } }] };
      if (!failed) {
        failed = true;
        throw providerOutage();
      }
      return { text: REPLY };
    };
    const sent = await talk([allowed.id], "Как упаковать экспертизу?");
    expect(sent).toEqual([REPLY, VIDEO_TEXT]);
    expect((await outboundOf(kit)).filter((row) => row.video)).toHaveLength(1);
  });

  it("два ролика за ответ — человеку уходит только первый, карточка показывает то же", async () => {
    kit.reply = (call) =>
      call.lastToolResult !== undefined
        ? { text: REPLY }
        : { toolCalls: [{ toolName: "show_video", input: { id: allowed.id, startSeconds: 200 } }, { toolName: "show_video", input: { id: second.id } }] };
    const sent = await talk([allowed.id, second.id], "Как упаковать экспертизу?");
    expect(sent).toEqual([REPLY, VIDEO_TEXT]);
    const owner = await kit.personOf(person);
    const card = await loadPersonCard({ db: kit.db, chatStorage: kit.chatStorage }, owner!.id);
    expect(card!.passages[0]!.messages.filter((message) => message.video)).toHaveLength(1);
  });

  it("ролик, уже показанный в разговоре, второй раз не уходит", async () => {
    showing(allowed.id, 200);
    await talk([allowed.id], "Как упаковать экспертизу?");
    const before = kit.textsTo(person).length;
    await kit.send(person, "А ещё раз ролик?");
    await kit.drain();
    expect(kit.textsTo(person).slice(before)).toEqual([REPLY]);
    expect((await outboundOf(kit)).filter((row) => row.video)).toHaveLength(1);
  });

  it("«Входящие» и карточка человека показывают ролик ссылкой, а не текстом инструмента", async () => {
    showing(allowed.id, 200);
    await talk([allowed.id], "Как упаковать экспертизу?");
    const link = { title: "Упаковка экспертизы", url: "https://www.youtube.com/watch?v=aircAruvnKk&t=200s", startLabel: "3:20" };
    const owner = await kit.personOf(person);

    const thread = await loadInboxThread(kit.db, owner!.id);
    expect(thread!.messages.at(-1)).toMatchObject({ direction: "out", video: link });
    expect(thread!.messages.at(-2)).toMatchObject({ text: "Посмотрите ролик — там как раз про это.", video: null });

    const card = await loadPersonCard({ db: kit.db, chatStorage: kit.chatStorage }, owner!.id);
    expect(card!.passages[0]!.messages.slice(-2)).toEqual([
      { role: "assistant", text: "Посмотрите ролик — там как раз про это." },
      { role: "assistant", text: "▶ Упаковка экспертизы\nс 3:20\nhttps://www.youtube.com/watch?v=aircAruvnKk&t=200s", video: link },
    ]);
  });

  it("ролик, не разрешённый лидмагниту, не уходит", async () => {
    showing(forbidden.id);
    const sent = await talk([allowed.id], "Покажи секретный ролик");
    expect(sent).toEqual(["Посмотрите ролик — там как раз про это."]);
    // Отказ инструмента с SDK 0.56 — ошибка вызова (`VideoLibraryError`), а не поле `отказ` в результате
    expect(kit.calls.at(-1)!.lastToolResult).toMatchObject({ type: "error-text", value: expect.stringContaining("VideoLibraryError") });
  });
});
