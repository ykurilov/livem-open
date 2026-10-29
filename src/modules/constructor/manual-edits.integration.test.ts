import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryChatStorage, type ChatStorage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import {
  appendManualEditNotes,
  createLeadMagnet,
  getLeadMagnet,
  getVersion,
  LeadMagnetNotFoundError,
  listVersions,
  lockLeadMagnet,
  saveDraft,
  type LeadMagnet,
} from "../lead-magnets";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "../platform/scripted-model";
import { clientCardFieldOf } from "../flows";
import { createField, deleteField } from "../people";
import { createImage, deleteImage } from "../images";
import { pngOf } from "../images/test-images";
import { createVideo, deleteVideo } from "../videos";
import { editLeadMagnet } from "./tools";
import {
  createConstructorEndpoint,
  rollbackByExpert,
  saveExpertCardDescription,
  saveExpertEdit,
  saveExpertFlowEdit,
  type ConstructorEndpoint,
} from "./index";

let database: TestDatabase;
let chatStorage: ChatStorage;
let endpoint: ConstructorEndpoint;
let calls: ScriptedCall[];
let lead: LeadMagnet;
/** Что модель сделает на следующий запрос; по умолчанию отвечает «Понял.». */
let nextReply: (call: ScriptedCall) => ScriptedReply;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  chatStorage = createInMemoryChatStorage();
  nextReply = () => ({ text: "Понял." });
  const scripted = createScriptedModel((call) => nextReply(call));
  calls = scripted.calls;
  endpoint = createConstructorEndpoint({
    db: database.db,
    chatStorage,
    catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
    defaultChoice: STUB_MODEL_CHOICE,
    env: { STUB_MODEL_API_KEY: "test" },
    resolveUser: async () => ({ id: "expert" }),
  });
  lead = await createLeadMagnet(database.db, { name: "Ручные правки" });
});

let messageCounter = 0;

async function post(chatId: string, action: string, body: unknown) {
  const response = await endpoint.fetch(
    new Request(`http://localhost/api/constructor/${chatId}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
  await response.text(); // дочитываем поток: ход закончен
}

const sendToConstructor = (chatId: string, text: string) =>
  post(chatId, "messages", { message: { id: `user-${++messageCounter}`, role: "user", parts: [{ type: "text", text }] } });

async function pending() {
  return (await getLeadMagnet(database.db, lead.id))!.pendingManualEdits;
}

describe("конструктор узнаёт о ручной правке", () => {
  it("один чат конструктора на лидмагнит", async () => {
    const first = await endpoint.ensureChat(lead.id);
    expect(await endpoint.ensureChat(lead.id)).toBe(first);
    expect((await getLeadMagnet(database.db, lead.id))?.constructorChatId).toBe(first);
  });

  it("ручная правка — версия «manual» и заметка в очереди", async () => {
    await saveExpertEdit(database.db, lead.id, { settings: { ...lead.draft, firstMessage: "Добрый день!" }, expectedVersionId: lead.draftVersionId });
    expect((await listVersions(database.db, lead.id))[0]!.source).toBe("manual");
    expect((await pending()).map((note) => note.text)).toEqual(["Первое сообщение: было «» → стало «Добрый день!»"]);
  });

  it("подключённое поле в заметке названо по имени", async () => {
    const field = await createField(database.db, { name: "Бюджет на рекламу", type: "number", description: "сколько готов тратить" });
    const flow = { ...lead.draft.flow, clientCard: [clientCardFieldOf(field)] };
    await saveExpertEdit(database.db, lead.id, { settings: { ...lead.draft, flow }, expectedVersionId: lead.draftVersionId });
    expect((await pending()).map((note) => note.text)).toEqual(["Поля: подключено поле «Бюджет на рекламу»"]);
  });

  it("ручное включение ролика — в заметке по названию; удалённые ролики при сохранении вычищаются", async () => {
    const sample = { url: "https://kinescope.io/abc123", description: "Про цены." };
    const live = await createVideo(database.db, { ...sample, title: "Цены на услуги" });
    const gone = await createVideo(database.db, { ...sample, title: "Старый ролик" });
    await deleteVideo(database.db, gone.id, new Date());
    const { version } = await saveExpertEdit(database.db, lead.id, {
      settings: { ...lead.draft, videoIds: [live.id, gone.id] },
      expectedVersionId: lead.draftVersionId,
    });
    expect(version.settings.videoIds).toEqual([live.id]);
    expect((await getLeadMagnet(database.db, lead.id))!.draft.videoIds).toEqual([live.id]);
    expect((await pending()).map((note) => note.text)).toEqual(["Видео: включён ролик «Цены на услуги»"]);
  });

  it("ручное включение картинки — в заметке по названию; удалённые картинки при сохранении вычищаются", async () => {
    const file = { bytes: pngOf(10, 10) };
    const uploads = await mkdtemp(join(tmpdir(), "manual-edits-"));
    const live = await createImage(database.db, { title: "Готовое приложение", description: "Где кнопка." }, file, uploads);
    const gone = await createImage(database.db, { title: "Старый скриншот", description: "Был." }, file, uploads);
    await deleteImage(database.db, gone.id, new Date());
    const { version } = await saveExpertEdit(database.db, lead.id, {
      settings: { ...lead.draft, imageIds: [live.id, gone.id] },
      expectedVersionId: lead.draftVersionId,
    });
    expect(version.settings.imageIds).toEqual([live.id]);
    expect((await pending()).map((note) => note.text)).toEqual(["Картинки: включена картинка «Готовое приложение»"]);
  });

  it("заметка уходит хвостом следующего сообщения и очищается после хода", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    await saveExpertEdit(database.db, lead.id, { settings: { ...lead.draft, firstMessage: "Добрый день!" }, expectedVersionId: lead.draftVersionId });

    await sendToConstructor(chatId, "Посмотри, что я поменял");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.lastUserText).toContain("Посмотри, что я поменял");
    expect(calls[0]!.lastUserText).toContain("Эксперт вручную изменил:");
    expect(calls[0]!.lastUserText).toContain("стало «Добрый день!»");
    expect(await pending()).toEqual([]);

    await sendToConstructor(chatId, "А теперь?");
    expect(calls[1]!.lastUserText).not.toContain("Эксперт вручную изменил");
  });

  it("заметка в хвосте, а не в системной инструкции: инструкция между ходами та же", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    await sendToConstructor(chatId, "Привет");
    await saveExpertEdit(database.db, lead.id, { settings: { ...lead.draft, name: "Новое имя" }, expectedVersionId: lead.draftVersionId });
    await sendToConstructor(chatId, "Что изменилось?");
    expect(calls[0]!.system).toBe(calls[1]!.system);
    expect(calls[1]!.system).not.toContain("Новое имя");
  });

  it("инструменты конструктора видят свой лидмагнит по чату", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    await sendToConstructor(chatId, "Привет");
    expect([...calls[0]!.toolNames].sort()).toEqual(["edit_lead_magnet", "read_test_conversation", "view_lead_magnet"]);
  });
});

describe("заметки стираются только после удачного хода", () => {
  it("ход сорвался — заметки остаются; повтор уносит их и стирает", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    await saveExpertEdit(database.db, lead.id, { settings: { ...lead.draft, firstMessage: "Добрый день!" }, expectedVersionId: lead.draftVersionId });

    nextReply = () => {
      throw new Error("модель упала");
    };
    await sendToConstructor(chatId, "Посмотри правку");
    expect((await pending()).map((note) => note.text)).toEqual(["Первое сообщение: было «» → стало «Добрый день!»"]);

    nextReply = () => ({ text: "Вижу." });
    await post(chatId, "retry", {});
    expect(calls.at(-1)!.lastUserText).toContain("стало «Добрый день!»");
    expect(await pending()).toEqual([]);
  });

  it("хвост длиннее предела — уходят самые свежие заметки, стираются только ушедшие", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    const texts = Array.from({ length: 30 }, (_, index) => `Заметка ${String(index).padStart(2, "0")}: ${"х".repeat(280)}`);
    await appendManualEditNotes(database.db, lead.id, texts);

    await sendToConstructor(chatId, "Что нового?");
    const sentTail = calls[0]!.lastUserText;
    expect(sentTail).toContain("Заметка 29");
    expect(sentTail).not.toContain("Заметка 00");
    expect(sentTail).not.toContain("…"); // заметки целиком, без обрезки на полуслове

    const left = (await pending()).map((note) => note.text.slice(0, 10));
    expect(left.length).toBeGreaterThan(0);
    expect(left).toContain("Заметка 00");
    for (const text of left) expect(sentTail).not.toContain(text);
  });
});

describe("две правки подряд: побеждает последняя", () => {
  it("черновик успел измениться — форма эксперта сохраняется поверх, конструктор получает заметку", async () => {
    await editLeadMagnet({ db: database.db, chatStorage }, lead.id, {
      changes: [{ op: "set", field: "firstMessage", value: "От конструктора" }],
    });
    const result = await saveExpertEdit(database.db, lead.id, {
      settings: { ...lead.draft, name: "Устаревшая форма" },
      expectedVersionId: lead.draftVersionId,
    });
    expect(result.overwroteNewerDraft).toBe(true);
    const after = (await getLeadMagnet(database.db, lead.id))!;
    expect(after.draftVersionId).toBe(result.version.id);
    expect(after.draft.name).toBe("Устаревшая форма");
    expect(after.draft.firstMessage).toBe(lead.draft.firstMessage);
    const notes = after.pendingManualEdits.map((note) => note.text);
    expect(notes[0]).toMatch(/поверх/);
    expect(notes.join("\n")).toContain("«От конструктора»");
  });

  it("черновик не менялся — без пометки о перезаписи", async () => {
    const result = await saveExpertEdit(database.db, lead.id, {
      settings: { ...lead.draft, name: "Свежая форма" },
      expectedVersionId: lead.draftVersionId,
    });
    expect(result.overwroteNewerDraft).toBe(false);
    const notes = (await getLeadMagnet(database.db, lead.id))!.pendingManualEdits.map((note) => note.text);
    expect(notes.join("\n")).not.toMatch(/поверх/);
  });

  it("одновременные правки конструктора и эксперта: обе проходят, черновик — от последней", async () => {
    for (let round = 0; round < 10; round++) {
      const current = (await getLeadMagnet(database.db, lead.id))!;
      const [byConstructor, byExpert] = await Promise.allSettled([
        editLeadMagnet({ db: database.db, chatStorage }, lead.id, {
          changes: [{ op: "set", field: "farewellMessage", value: `Конструктор ${round}` }],
        }),
        saveExpertEdit(database.db, lead.id, {
          settings: { ...current.draft, cardDescription: `Эксперт ${round}` },
          expectedVersionId: current.draftVersionId,
        }),
      ]);
      expect(byConstructor).toMatchObject({ status: "fulfilled", value: { ok: true } });
      expect(byExpert.status).toBe("fulfilled");
      const draft = (await getLeadMagnet(database.db, lead.id))!.draft;
      expect(draft.cardDescription).toBe(`Эксперт ${round}`);
      const expertWasLast = byExpert.status === "fulfilled" && byExpert.value.overwroteNewerDraft;
      expect(draft.farewellMessage).toBe(expertWasLast ? current.draft.farewellMessage : `Конструктор ${round}`);
    }
  });

  it("лидмагнита нет — понятная ошибка", async () => {
    await expect(
      saveExpertEdit(database.db, "00000000-0000-4000-8000-000000000000", { settings: lead.draft, expectedVersionId: lead.draftVersionId }),
    ).rejects.toBeInstanceOf(LeadMagnetNotFoundError);
  });
});

/** Ждёт, пока какой-то запрос этой базы встанет в очередь за блокировкой строки. */
async function waitForLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await database.pool.query<{ waiting: number }>(
      "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if (rows[0]!.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Запрос так и не встал за блокировкой");
}

describe("сценарий с доски", () => {
  it("конструктор сохранил черновик, пока доска ждала блокировку: его правка остаётся, сценарий — с доски", async () => {
    const opened = (await getLeadMagnet(database.db, lead.id))!;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let saved!: () => void;
    const constructorSaved = new Promise<void>((resolve) => (saved = resolve));
    // Ход конструктора: блокировка строки и новый черновик, коммит — позже
    const byConstructor = database.db.transaction(async (tx) => {
      const current = await lockLeadMagnet(tx, lead.id);
      await saveDraft(tx, lead.id, { ...current.draft, firstMessage: "От конструктора" }, "constructor");
      saved();
      await released;
    });
    await constructorSaved;
    const byBoard = saveExpertFlowEdit(database.db, lead.id, {
      flow: { ...opened.draft.flow, common: "Общее с доски" },
      expectedVersionId: opened.draftVersionId,
    });
    await waitForLockWait();
    release();
    await byConstructor;
    const result = await byBoard;

    const after = (await getLeadMagnet(database.db, lead.id))!;
    expect(after.draftVersionId).toBe(result.version.id);
    expect(after.draft.firstMessage).toBe("От конструктора");
    expect(after.draft.flow.common).toBe("Общее с доски");
    // Основная инструкция повторяет «Общее» сценария
    expect(after.draft.instruction).toBe("Общее с доски");
    expect(result.overwroteNewerDraft).toBe(true);
  });

  it("одновременно с конструктором: обе правки в черновике при любом порядке", async () => {
    for (let round = 0; round < 10; round++) {
      const opened = (await getLeadMagnet(database.db, lead.id))!;
      const [byConstructor, byBoard] = await Promise.allSettled([
        editLeadMagnet({ db: database.db, chatStorage }, lead.id, {
          changes: [{ op: "set", field: "farewellMessage", value: `Конструктор ${round}` }],
        }),
        saveExpertFlowEdit(database.db, lead.id, {
          flow: { ...opened.draft.flow, common: `Доска ${round}` },
          expectedVersionId: opened.draftVersionId,
        }),
      ]);
      expect(byConstructor).toMatchObject({ status: "fulfilled", value: { ok: true } });
      expect(byBoard.status).toBe("fulfilled");
      const draft = (await getLeadMagnet(database.db, lead.id))!.draft;
      expect(draft.farewellMessage).toBe(`Конструктор ${round}`);
      expect(draft.flow.common).toBe(`Доска ${round}`);
    }
  });

  it("поля карточки и просмотр ссылок черновика — по сценарию с доски", async () => {
    const field = await createField(database.db, { name: "Город с доски", type: "text", description: "" });
    const opened = (await getLeadMagnet(database.db, lead.id))!;
    await saveExpertFlowEdit(database.db, lead.id, {
      flow: { ...opened.draft.flow, clientCard: [clientCardFieldOf(field)] },
      expectedVersionId: opened.draftVersionId,
    });
    const after = (await getLeadMagnet(database.db, lead.id))!;
    expect(after.draft.fieldIds).toEqual([field.id]);
  });
});

describe("описание карточки с главной страницы", () => {
  it("ложится в самый свежий черновик, остальное не трогает, конструктор узнаёт о правке", async () => {
    await editLeadMagnet({ db: database.db, chatStorage }, lead.id, {
      changes: [{ op: "set", field: "farewellMessage", value: "От конструктора" }],
    });
    const before = (await getLeadMagnet(database.db, lead.id))!;
    const version = await saveExpertCardDescription(database.db, lead.id, "  Три дня до первого приложения  ");

    const after = (await getLeadMagnet(database.db, lead.id))!;
    expect(after.draftVersionId).toBe(version.id);
    expect(after.draft).toEqual({ ...before.draft, cardDescription: "Три дня до первого приложения" });
    expect((await pending()).map((note) => note.text)).toContainEqual(expect.stringContaining("Описание карточки"));
  });

  it("то же описание — без новой версии", async () => {
    const version = await saveExpertCardDescription(database.db, lead.id, "Одно и то же");
    expect((await saveExpertCardDescription(database.db, lead.id, "Одно и то же")).id).toBe(version.id);
  });
});

describe("поле удалили из словаря", () => {
  /** Черновик с полем в карточке и попутной задачей на него; поле затем удалено из «Базы». */
  async function draftWithDeletedField() {
    const field = await createField(database.db, { name: `Город ${randomUUID()}`, type: "text", description: "" });
    const attached = await editLeadMagnet({ db: database.db, chatStorage }, lead.id, {
      changes: [
        { op: "attach_field", fieldId: field.id },
        { op: "put_side_tasks", sideTasks: [{ text: "К слову узнать город", field: field.id }] },
      ],
    });
    expect(attached).toMatchObject({ ok: true });
    const withField = (await getLeadMagnet(database.db, lead.id))!;
    await deleteField(database.db, field.id, new Date());
    return { field, withField };
  }

  const cardIds = (settings: LeadMagnet["draft"]) => settings.flow.clientCard.map((one) => one.id);

  it("следующая правка конструктора проходит: поле уходит из карточки, попутная задача остаётся без поля", async () => {
    const { field, withField } = await draftWithDeletedField();
    const result = await editLeadMagnet({ db: database.db, chatStorage }, lead.id, {
      changes: [{ op: "set", field: "firstMessage", value: "Здравствуйте!" }],
    });
    expect(result).toMatchObject({ ok: true });
    const draft = (await getLeadMagnet(database.db, lead.id))!.draft;
    expect(draft.firstMessage).toBe("Здравствуйте!");
    expect(cardIds(draft)).not.toContain(field.id);
    expect(draft.fieldIds).not.toContain(field.id);
    expect(draft.flow.sideTasks).toEqual([expect.objectContaining({ text: "К слову узнать город" })]);
    expect(draft.flow.sideTasks![0]!.field).toBeUndefined();
    // Прежние версии неизменны
    expect(cardIds((await getVersion(database.db, withField.draftVersionId))!.settings)).toContain(field.id);
  });

  it("сценарий с доски и ручная правка тоже убирают удалённое поле", async () => {
    const { field, withField } = await draftWithDeletedField();
    await saveExpertFlowEdit(database.db, lead.id, {
      flow: { ...withField.draft.flow, common: "Общее" },
      expectedVersionId: withField.draftVersionId,
    });
    let draft = (await getLeadMagnet(database.db, lead.id))!.draft;
    expect(cardIds(draft)).not.toContain(field.id);
    expect(draft.flow.sideTasks![0]!.field).toBeUndefined();

    const current = (await getLeadMagnet(database.db, lead.id))!;
    await saveExpertEdit(database.db, lead.id, { settings: { ...withField.draft, name: "Форма с удалённым полем" }, expectedVersionId: current.draftVersionId });
    draft = (await getLeadMagnet(database.db, lead.id))!.draft;
    expect(draft.name).toBe("Форма с удалённым полем");
    expect(cardIds(draft)).not.toContain(field.id);
    expect(draft.fieldIds).not.toContain(field.id);
    expect(draft.flow.sideTasks![0]!.field).toBeUndefined();
  });

  it("выдуманный id поля в карточке конструктор по-прежнему отвергает", async () => {
    const invented = randomUUID();
    const current = (await getLeadMagnet(database.db, lead.id))!;
    const field = await createField(database.db, { name: `Профессия ${randomUUID()}`, type: "text", description: "" });
    const card = [{ ...clientCardFieldOf(field), id: invented }];
    await saveDraft(database.db, lead.id, { ...current.draft, flow: { ...current.draft.flow, clientCard: card }, fieldIds: [invented] }, "agent");
    const result = await editLeadMagnet({ db: database.db, chatStorage }, lead.id, {
      changes: [{ op: "set", field: "firstMessage", value: "Здравствуйте!" }],
    });
    expect(result.ok).toBe(false);
    expect(cardIds((await getLeadMagnet(database.db, lead.id))!.draft)).toEqual([invented]);
  });
});

describe("откат экспертом", () => {
  it("черновик возвращается к версии, конструктор получает короткую заметку", async () => {
    const first = lead.draftVersionId;
    const changed = await saveDraft(database.db, lead.id, { ...lead.draft, instruction: "Длинная новая инструкция" }, "constructor");
    await rollbackByExpert(database.db, lead.id, { versionId: first, expectedVersionId: changed.id });

    const after = (await getLeadMagnet(database.db, lead.id))!;
    expect(after.draft.instruction).toBe("");
    expect((await listVersions(database.db, lead.id))[0]!.source).toBe("rollback");
    const notes = after.pendingManualEdits.map((note) => note.text);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^Эксперт вернул черновик к версии от \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/);
    expect(notes[0]).not.toContain("Длинная новая инструкция");
  });

  it("черновик успел измениться — откат всё равно проходит, с пометкой о перезаписи", async () => {
    const first = lead.draftVersionId;
    await saveDraft(database.db, lead.id, { ...lead.draft, name: "Свежая" }, "constructor");
    const result = await rollbackByExpert(database.db, lead.id, { versionId: first, expectedVersionId: first });
    expect(result.overwroteNewerDraft).toBe(true);
    const after = (await getLeadMagnet(database.db, lead.id))!;
    expect(after.draft.name).toBe(lead.draft.name);
    expect(after.pendingManualEdits.map((note) => note.text).join("\n")).toMatch(/поверх/);
  });
});
