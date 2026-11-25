import { createInMemoryChatStorage, loadCurrentBranch, SUGGESTIONS_SHOWN_AFTER_ANSWER, type ChatStorage } from "@ykurilov/agent-chat-core";
import { createMemoryAttachmentStorage } from "@ykurilov/agent-chat-attachments";
import { createChatImages } from "../platform/chat-attachments";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { timeZoneAtHour } from "../../../tests/time-zone-at-hour";
import { previewOwnerId } from "../platform/cabinet-owner";
import { createClock } from "../platform/clock";
import { eq } from "drizzle-orm";
import { leadMagnetToFlow } from "../flows/settings-to-flow";
import { listAgentLog } from "../agent-log";
import { createLeadMagnet, getLeadMagnet, newProgramSettings, saveDraft as saveSettings, type LeadMagnet, type LeadMagnetSettings } from "../lead-magnets";
import { createVideo, shownVideosOf } from "../videos";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "../platform/scripted-model";
import { createPreviewEndpoint, PreviewReopenRefused, type PreviewEndpoint } from "./preview-endpoint";
import { createPreviewConversationStore, readPreviewConversation } from "./preview-store";
import { previewConversations } from "./schema";
import { recordCorrection } from "../corrections";
import { HANDOFF_NOTICE_MARK } from "../messenger-handoff/notice";
import { MESSENGER_HANDOFF_EVENT } from "../messenger-handoff/setting";
import { freeCallTimes } from "../booking/bookings";
import { saveCallWindow, updateCallCalendar } from "../booking/calendar";
import { CALL_BOOKED_EVENT } from "../booking/setting";
import { localDate } from "../program/calendar";

let database: TestDatabase;
let chatStorage: ChatStorage;
let endpoint: PreviewEndpoint;
let calls: ScriptedCall[];
let lead: LeadMagnet;
let signedIn: boolean;
let reply: (call: ScriptedCall) => ScriptedReply;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

// Дни программы зависят от часа: вечером, позже чем за 3 часа до ночи, первым днём считается завтра. Часы тестов
// сдвинуты так, что по Москве (пояс по умолчанию) идёт полдень, в какое бы время ни шёл прогон
const DAY_MS = 86_400_000;
const shiftToNoon = 12 * 3_600_000 - ((Date.now() + 3 * 3_600_000) % DAY_MS);
const noonInMoscow = createClock(() => new Date(Date.now() + shiftToNoon));

beforeEach(async () => {
  // Все тестовые чаты — одного владельца («кабинет»): потолок сообщений первым за день и таймеры прошлых тестов
  // (их чаты — в своих хранилищах) не должны доставаться этому
  await database.pool.query(
    "do $$ begin if to_regclass('agent_chat.flow_chats') is not null then delete from agent_chat.flow_chats; delete from agent_chat.flow_first_messages; end if; end $$",
  );
  chatStorage = createInMemoryChatStorage();
  signedIn = true;
  reply = () => ({ text: "Расскажите подробнее." });
  const scripted = createScriptedModel((call) => reply(call));
  calls = scripted.calls;
  endpoint = createPreviewEndpoint({
    db: database.db,
    pool: database.pool,
    judgeFallback: STUB_MODEL_CHOICE,
    chatStorage,
    catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
    env: { STUB_MODEL_API_KEY: "test" },
    resolveUser: async () => (signedIn ? { id: "expert" } : null),
    modelChoice: () => STUB_MODEL_CHOICE,
    clock: noonInMoscow,
    attachments: createChatImages(createMemoryAttachmentStorage()),
  });
  const created = await createLeadMagnet(database.db, { name: "Превью" });
  await saveDraft(database.db, created.id, { ...created.draft, instruction: "Ты консультант превью." }, "manual");
  lead = created;
});

/** Черновик из старых полей (инструкция, этапы, программа) — со сценарием из них, как при переводе настроек. */
const saveDraft = (db: typeof database.db, id: string, settings: LeadMagnetSettings, by: "manual") =>
  saveSettings(db, id, { ...settings, flow: leadMagnetToFlow(settings, []) }, by);

/** «Если человек вернулся после конца» — «Передать мне во «Входящие»»: после конца тестовый разговор не отвечает. */
const toInbox = async () => {
  const current = (await getLeadMagnet(database.db, lead.id))!;
  await saveSettings(database.db, lead.id, { ...current.draft, returnAfterProgram: "inbox" }, "manual");
};

let counter = 0;
const send = (chatId: string, text: string) =>
  endpoint.fetch(
    new Request(`http://localhost/api/preview/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: `m-${++counter}`, role: "user", parts: [{ type: "text", text }] } }),
    }),
  );

describe("тестовый разговор: порядок проверок", () => {
  it("без входа — 401 раньше всего: даже у завершённого разговора и без записей в хранилище", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await createPreviewConversationStore(database.db).finish(chatId, { goal: "a", stuckAt: "b", chosenStep: "c" });
    const updateChatModel = vi.spyOn(chatStorage, "updateChatModel");
    signedIn = false;

    const response = await send(chatId, "Привет");
    expect(response.status).toBe(401);
    expect(updateChatModel).not.toHaveBeenCalled();
  });

  // Чат показывает человеку текст из error.message: в нём должно быть, что делать дальше
  it("завершённый разговор у «Передать мне во «Входящие»» — 409 с понятным текстом", async () => {
    await toInbox();
    const chatId = await endpoint.ensurePreview(lead.id);
    await createPreviewConversationStore(database.db).finish(chatId, { goal: "a", stuckAt: "b", chosenStep: "c" });
    const response = await send(chatId, "Привет");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/завершён.*«Продолжить разговор»/);
  });

  it("старый разговор после «Начать заново» — 409 с понятным текстом, модель не зовётся", async () => {
    const oldChat = await endpoint.ensurePreview(lead.id);
    await endpoint.restartPreview(lead.id);

    const response = await send(oldChat, "Привет");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/начат заново|устарел/i);
    expect(calls).toHaveLength(0);
  });

  it("чужой или несуществующий чат — 404, модель не зовётся", async () => {
    const response = await send("нет-такого-чата", "Привет");
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("текущий разговор идёт с инструкцией лидмагнита", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    const response = await send(chatId, "Привет");
    expect(response.status).toBe(200);
    await response.text();
    expect(calls[0]!.system).toContain("Ты консультант превью.");
  });

  it("текст до инструмента и после — в истории остаётся один ответ: тот, что после инструмента", async () => {
    reply = (call) =>
      call.lastToolResult !== undefined
        ? { text: "Так что было в тот раз?" }
        : { text: "Вспомни последний раз, что вышло?", toolCalls: [{ toolName: "flow_note", input: { fact: "Показывает другим" } }] };
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Я показывал сборку")).text();

    const answer = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
    expect(answer.status).toBe("complete");
    const texts = answer.parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
    expect(texts).toEqual(["Так что было в тот раз?"]);
    expect(answer.parts.some((part) => part.type === "tool-flow_note")).toBe(true);
  });

  it("ответ с кнопками закрыт: вопрос остаётся, дописки после кнопок нет ни в ленте, ни в истории", async () => {
    const QUESTION = "Что соберём первым: игру или сайт?";
    reply = (call) =>
      call.lastToolResult !== undefined
        ? { text: "Жду ваш выбор." }
        : { text: QUESTION, toolCalls: [{ toolName: "suggest_replies", input: { replies: ["Игру", "Сайт"] } }] };
    const chatId = await endpoint.ensurePreview(lead.id);
    const stream = await (await send(chatId, "Привет! Дима.")).text();

    expect(stream).not.toContain("Жду ваш выбор");
    const answer = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
    expect(answer.status).toBe("complete");
    expect(answer.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual([QUESTION]);
    expect(answer.parts.some((part) => part.type === "tool-suggest_replies")).toBe(true);
  });

  it("запись о человеке после кнопок выполняется, в ленте и истории — только вопрос", async () => {
    const QUESTION = "Что соберём первым: игру или сайт?";
    reply = (call) => {
      if (call.lastToolResult === undefined) return { text: QUESTION, toolCalls: [{ toolName: "suggest_replies", input: { replies: ["Игру", "Сайт"] } }] };
      if (JSON.stringify(call.lastToolResult).includes(SUGGESTIONS_SHOWN_AFTER_ANSWER)) return { toolCalls: [{ toolName: "flow_note", input: { fact: "Его зовут Дима" } }] };
      return { text: "Чтобы легче было выбрать, расскажу подробнее." };
    };
    const chatId = await endpoint.ensurePreview(lead.id);
    const stream = await (await send(chatId, "Привет! Дима.")).text();

    expect(stream).not.toContain("Чтобы легче было выбрать");
    const answer = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
    expect(answer.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual([QUESTION]);
    expect(answer.parts.find((part) => part.type === "tool-flow_note")).toMatchObject({ state: "output-available" });
  });

  it("кнопки раньше текста: ход идёт дальше, и вопрос пишется после них", async () => {
    const QUESTION = "Что соберём первым: игру или сайт?";
    reply = (call) =>
      call.lastToolResult !== undefined ? { text: QUESTION } : { toolCalls: [{ toolName: "suggest_replies", input: { replies: ["Игру", "Сайт"] } }] };
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет! Дима.")).text();

    const answer = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
    expect(answer.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual([QUESTION]);
    expect(answer.parts.some((part) => part.type === "tool-suggest_replies")).toBe(true);
  });

  it("английская фраза перед инструментом не печатается эксперту даже на миг: ответ держится до проверки", async () => {
    reply = (call) => {
      if (call.lastUserText.includes("Чужие слова:")) return { text: "Хорошо, сейчас всё отмечу для себя." };
      return call.lastToolResult !== undefined
        ? { text: "Так что было в тот раз?" }
        : { text: "Okay, let me quickly note everything down.", toolCalls: [{ toolName: "flow_note", input: { fact: "Показывает другим" } }] };
    };
    const chatId = await endpoint.ensurePreview(lead.id);
    const stream = await (await send(chatId, "Я показывал сборку")).text();

    expect(stream).not.toContain("let me");
    expect(stream).toContain("Так что было в тот раз?");
  });
});

describe("тестовый разговор: прощание приложения — в ленте, в том же ответе, что получит человек", () => {
  const summary = { goal: "Курс", stuckAt: "Нет идеи", chosenStep: "Собрать идею", outcome: "agreed" };
  const FAREWELL = "Удачи с курсом!";
  const answerTexts = async (chatId: string) => {
    const answer = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
    expect(answer.status).toBe("complete");
    return answer.parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
  };

  beforeEach(async () => {
    await saveDraft(database.db, lead.id, { ...lead.draft, instruction: "Ты консультант превью.", farewellMessage: FAREWELL }, "manual");
  });

  it("finish_dialog с agreed, потом текст модели: в ленте только прощание", async () => {
    reply = (call) =>
      call.lastToolResult !== undefined
        ? { text: "Идея собрана: курс для новичков." }
        : { toolCalls: [{ toolName: "finish_dialog", input: summary }] };
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Да, подходит")).text();

    expect(await answerTexts(chatId)).toEqual([FAREWELL]);
  });

  it("finish_dialog с answer: в ленте ответ на вопрос, потом прощание", async () => {
    reply = (call) =>
      call.lastToolResult !== undefined
        ? { text: "Отлично! До встречи!" }
        : { toolCalls: [{ toolName: "finish_dialog", input: { ...summary, answer: "Курс стартует, когда эксперт подтвердит дату." } }] };
    const chatId = await endpoint.restartPreview(lead.id);
    await (await send(chatId, "Да, подходит. А когда старт?")).text();

    expect(await answerTexts(chatId)).toEqual([`Курс стартует, когда эксперт подтвердит дату.\n\n${FAREWELL}`]);
  });

  it("текст до finish_dialog с agreed тоже не попадает: в ленте только прощание", async () => {
    reply = (call) =>
      call.lastToolResult !== undefined ? {} : { text: "Идея собрана.", toolCalls: [{ toolName: "finish_dialog", input: summary }] };
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Да, подходит")).text();

    expect(await answerTexts(chatId)).toEqual([FAREWELL]);
  });

  it("после finish_dialog с agreed консультант ничего не написал — в ленте только прощание, пустого сообщения нет", async () => {
    reply = (call) => (call.lastToolResult !== undefined ? {} : { toolCalls: [{ toolName: "finish_dialog", input: summary }] });
    const chatId = await endpoint.restartPreview(lead.id);
    await (await send(chatId, "Да, подходит")).text();

    expect(await answerTexts(chatId)).toEqual([FAREWELL]);
  });

  it("человек отказался или ушёл — прощания приложения нет, только ответ консультанта", async () => {
    for (const outcome of ["declined", "left"]) {
      reply = (call) =>
        call.lastToolResult !== undefined
          ? { text: "Хорошо, удачи!" }
          : { toolCalls: [{ toolName: "finish_dialog", input: { ...summary, outcome } }] };
      const chatId = await endpoint.restartPreview(lead.id);
      await (await send(chatId, "Нет, не надо")).text();
      expect(await answerTexts(chatId)).toEqual(["Хорошо, удачи!"]);
    }
  });

  it("чужие слова в ответе на вопрос переписываются, прощание эксперта в переписку не уходит", async () => {
    const farewell = "Thanks! 加油, до встречи.";
    await saveDraft(database.db, lead.id, { ...lead.draft, instruction: "Ты консультант превью.", farewellMessage: farewell }, "manual");
    const rewrites: string[] = [];
    reply = (call) => {
      if (call.lastUserText.includes("Чужие слова:")) {
        rewrites.push(call.lastUserText);
        return { text: "На самом деле старт скоро." };
      }
      return call.lastToolResult !== undefined
        ? { text: "До встречи!" }
        : { toolCalls: [{ toolName: "finish_dialog", input: { ...summary, answer: "Actually, старт скоро." } }] };
    };
    const chatId = await endpoint.restartPreview(lead.id);
    await (await send(chatId, "Да, подходит. А когда старт?")).text();

    expect(await answerTexts(chatId)).toEqual([`На самом деле старт скоро.\n\n${farewell}`]);
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]).not.toContain("加油");
  });

  it("разговор не завершён — прощания нет", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет")).text();

    expect(await answerTexts(chatId)).toEqual(["Расскажите подробнее."]);
  });
});

describe("завершённый тестовый разговор можно продолжить", () => {
  const summary = { goal: "Курс", stuckAt: "Нет идеи", chosenStep: "Собрать идею", outcome: "agreed" };
  const finishOnFirstTurn = () => {
    let finished = false;
    reply = (call) => {
      if (finished) return { text: "Продолжим: что ещё важно?" };
      if (call.lastToolResult !== undefined) {
        finished = true;
        return { text: "Идея собрана." };
      }
      return { toolCalls: [{ toolName: "finish_dialog", input: summary }] };
    };
  };
  const finishedChat = async () => {
    finishOnFirstTurn();
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Да, подходит")).text();
    expect((await endpoint.status(lead.id))?.finished).toBe(true);
    return chatId;
  };

  it("«Продолжить разговор»: статус снова «идёт», следующее сообщение получает ответ консультанта", async () => {
    const chatId = await finishedChat();

    await endpoint.reopenPreview(lead.id);
    expect((await endpoint.status(lead.id))?.finished).toBe(false);

    const response = await send(chatId, "А ещё вопрос");
    expect(response.status).toBe(200);
    await response.text();
    const answer = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
    expect(answer.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual(["Продолжим: что ещё важно?"]);
  });

  it("после «Продолжить разговор» прощание прошлого конца не подменяет новый ответ", async () => {
    const current = (await getLeadMagnet(database.db, lead.id))!;
    await saveSettings(database.db, lead.id, { ...current.draft, farewellMessage: "Спасибо, до встречи!" }, "manual");
    const chatId = await finishedChat();

    await endpoint.reopenPreview(lead.id);
    await (await send(chatId, "А ещё вопрос")).text();

    const answer = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
    expect(answer.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual(["Продолжим: что ещё важно?"]);
  });

  it("правка своей прошлой реплики открывает завершённый разговор сама: ответ идёт с новой ветки", async () => {
    const chatId = await finishedChat();
    const edited = (await chatStorage.listMessages(chatId)).find((message) => message.role === "user")!;

    const response = await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editedMessageId: edited.id, message: { id: `m-${++counter}`, role: "user", parts: [{ type: "text", text: "Пока не уверен" }] } }),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect((await endpoint.status(lead.id))?.finished).toBe(false);
    expect((await readPreviewConversation(database.db, chatId))?.finishedAt).toBeNull();
  });

  it("сценарий не открывается (срок программы вышел): разговор остаётся завершённым, отказ говорит, что делать", async () => {
    const chatId = await finishedChat();
    vi.spyOn(endpoint.flow, "reopen").mockResolvedValue({ reopened: false, reason: "deadline_passed" });

    await expect(endpoint.reopenPreview(lead.id)).rejects.toThrow(PreviewReopenRefused);
    await expect(endpoint.reopenPreview(lead.id)).rejects.toThrow(/срок.*«Начать проверку заново»/is);
    expect((await endpoint.status(lead.id))?.finished).toBe(true);
    expect((await readPreviewConversation(database.db, chatId))?.summary).not.toBeNull();
  });

  it("правка реплики, когда сценарий не открывается: 409 с тем же объяснением, разговор остаётся завершённым", async () => {
    const chatId = await finishedChat();
    vi.spyOn(endpoint.flow, "reopen").mockResolvedValue({ reopened: false, reason: "deadline_passed" });
    const edited = (await chatStorage.listMessages(chatId)).find((message) => message.role === "user")!;

    const response = await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editedMessageId: edited.id, message: { id: `m-${++counter}`, role: "user", parts: [{ type: "text", text: "Пока не уверен" }] } }),
      }),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/«Начать проверку заново»/);
    expect((await endpoint.status(lead.id))?.finished).toBe(true);
  });

  it("«Продолжить» у незавершённого разговора ничего не ломает", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await endpoint.reopenPreview(lead.id);
    const response = await send(chatId, "Привет");
    expect(response.status).toBe(200);
    await response.text();
  });
});

describe("после конца с «Агент продолжит разговор» тестовый разговор отвечает, как живой", () => {
  const GUIDANCE = "Спроси, получилось ли применить разбор";
  const finishedChat = async () => {
    const current = (await getLeadMagnet(database.db, lead.id))!;
    await saveSettings(database.db, lead.id, { ...current.draft, returnAfterProgram: "continue", returnGuidance: GUIDANCE }, "manual");
    let finished = false;
    reply = (call) => {
      if (finished) return { text: "С возвращением! С чем пришли?" };
      if (call.lastToolResult !== undefined) {
        finished = true;
        return { text: "Идея собрана." };
      }
      return { toolCalls: [{ toolName: "finish_dialog", input: { goal: "Курс", stuckAt: "Нет идеи", chosenStep: "Собрать идею", outcome: "agreed" } }] };
    };
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Да, подходит")).text();
    expect((await endpoint.status(lead.id))?.finished).toBe(true);
    return chatId;
  };

  it("промотать полгода и написать: ответ по правилу после конца, с паузой; разговор остаётся завершённым", async () => {
    const chatId = await finishedChat();
    await expect(endpoint.advanceBy(lead.id, 200 * DAY_MS)).resolves.toBeGreaterThanOrEqual(200 * DAY_MS);

    const response = await send(chatId, "Здравствуйте, я снова к вам");
    expect(response.status).toBe(200);
    await response.text();
    const call = calls.at(-1)!;
    expect(call.system).toContain(GUIDANCE);
    expect(call.toolNames).toContain("hand_to_expert");
    expect(call.lastUserText).toContain("Человек вернулся после конца разговора");
    expect(call.lastUserText).toContain("Пауза: человек не писал");
    const answer = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
    expect(answer.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual(["С возвращением! С чем пришли?"]);
    expect((await endpoint.status(lead.id))?.finished).toBe(true);
  });

  it("«Передать мне во «Входящие»»: после конца перемотка и сообщения — отказ, как раньше", async () => {
    const chatId = await finishedChat();
    await toInbox();
    await expect(endpoint.advanceBy(lead.id, 15 * 60_000)).rejects.toThrow(/завершён/i);
    expect((await send(chatId, "Привет")).status).toBe(409);
  });
});

describe("после правки инструкций тестовый разговор идёт по новой версии", () => {
  /** Черновик с правилами ноды и общими правилами, помеченными словом: по нему видно, какая версия в запросе. */
  const withRules = async (word: string) => {
    const current = (await getLeadMagnet(database.db, lead.id))!;
    const flow = current.draft.flow;
    await saveSettings(
      database.db,
      lead.id,
      {
        ...current.draft,
        instruction: `Общее правило ${word}-ОБЩЕЕ.`,
        flow: {
          ...flow,
          common: `Общее правило ${word}-ОБЩЕЕ.`,
          states: flow.states.map((state, index) => (index === 0 ? { ...state, instructions: `Спроси про ${word}-НОДА.` } : state)),
        },
      },
      "manual",
    );
  };
  const wholeRequest = (call: ScriptedCall) => JSON.stringify(call.options.prompt);

  it("откат на шаг назад правкой реплики: в запросе только новые правила, старых нет ни в одном месте", async () => {
    await withRules("ЯБЛОКО");
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет")).text();
    await (await send(chatId, "Расскажу ещё")).text();
    expect(wholeRequest(calls.at(-1)!)).toContain("ЯБЛОКО-НОДА");

    await withRules("ГРУША");
    const second = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "user").at(-1)!;
    const response = await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editedMessageId: second.id, message: { id: `m-${++counter}`, role: "user", parts: [{ type: "text", text: "Расскажу иначе" }] } }),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();

    const request = wholeRequest(calls.at(-1)!);
    expect(request).toContain("ГРУША-НОДА");
    expect(request).toContain("ГРУША-ОБЩЕЕ");
    expect(request).not.toContain("ЯБЛОКО");
  });

  it("следующее сообщение после правки — тоже без старых правил", async () => {
    await withRules("ЯБЛОКО");
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет")).text();

    await withRules("ГРУША");
    await (await send(chatId, "Дальше")).text();
    const request = wholeRequest(calls.at(-1)!);
    expect(request).toContain("ГРУША-НОДА");
    expect(request).not.toContain("ЯБЛОКО");
  });
});

describe("«Автоответ» в тестовом разговоре", () => {
  it("модель в роли клиента отвечает на последнюю реплику консультанта с темой лидмагнита; в чат ничего не пишется", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    reply = () => ({ text: "Какой у вас запрос?" });
    await (await send(chatId, "Привет")).text();
    const before = await chatStorage.listMessages(chatId);
    reply = (call) => ({ text: call.system?.includes("Тема бота: Превью") ? "  Хочу похудеть к лету  " : "не та роль" });

    const suggestion = await endpoint.suggestReply(chatId);

    expect(suggestion).toBe("Хочу похудеть к лету");
    const call = calls.at(-1)!;
    expect(call.lastUserText).toBe("Какой у вас запрос?");
    expect(JSON.stringify(call.options.prompt)).toContain("Привет");
    expect(call.toolNames).toEqual([]);
    expect(await chatStorage.listMessages(chatId)).toHaveLength(before.length);
  });
});

describe("картинки клиента в тестовом разговоре", () => {
  // Картинка 1×1 PNG: SDK проверяет тип по содержимому, а не по имени
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const upload = async (chatId: string) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "shot.png");
    return endpoint.fetch(new Request(`http://localhost/api/preview/${chatId}/attachments`, { method: "POST", body: form }));
  };
  const allowImages = async (allowed: boolean) => {
    const current = (await getLeadMagnet(database.db, lead.id))!;
    await saveSettings(database.db, lead.id, { ...current.draft, clientImages: allowed }, "manual");
  };

  it("по умолчанию выключены: загрузка отклонена, в поле ввода скрепки нет", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    expect((await getLeadMagnet(database.db, lead.id))!.draft.clientImages).toBe(false);

    const response = await upload(chatId);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const chat = await (await endpoint.fetch(new Request(`http://localhost/api/preview/${chatId}`))).json();
    expect(chat.capabilities?.attachments).toBeFalsy();
  });

  it("включены: картинка клиента доходит до модели в его сообщении", async () => {
    await allowImages(true);
    const chatId = await endpoint.ensurePreview(lead.id);
    const response = await upload(chatId);
    expect(response.status).toBe(201);
    const { id: attachmentId } = (await response.json()) as { id: string };

    const sent = await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            id: `m-${++counter}`,
            role: "user",
            parts: [
              { type: "text", text: "Вот мой экран" },
              { type: "file", url: `attachment:${attachmentId}`, mediaType: "image/png", filename: "shot.png" },
            ],
          },
        }),
      }),
    );
    expect(sent.status).toBe(200);
    await sent.text();

    const lastUser = calls.at(-1)!.options.prompt.filter((message) => message.role === "user").at(-1)!;
    const parts = Array.isArray(lastUser.content) ? lastUser.content : [];
    expect(parts.some((part) => part.type === "file" && part.mediaType.startsWith("image/"))).toBe(true);
  });
});

describe("тестовый разговор: видео", () => {
  it("два show_video в одном ответе — карточка одна, второй вызов получает отказ", async () => {
    const first = await createVideo(database.db, { title: "Первый ролик", url: "https://kinescope.io/first1", description: "Про начало." });
    const second = await createVideo(database.db, { title: "Второй ролик", url: "https://kinescope.io/second1", description: "Про продолжение." });
    await saveDraft(database.db, lead.id, { ...lead.draft, instruction: "Ты консультант превью.", videoIds: [first.id, second.id] }, "manual");
    reply = (call) =>
      call.lastToolResult !== undefined
        ? { text: "Посмотрите ролик." }
        : { toolCalls: [{ toolName: "show_video", input: { id: first.id } }, { toolName: "show_video", input: { id: second.id } }] };
    const chatId = await endpoint.restartPreview(lead.id);
    await (await send(chatId, "Покажи ролики")).text();

    const answer = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
    expect(shownVideosOf(answer.parts).map((shown) => shown.id)).toEqual([first.id]);
    const refused = answer.parts.filter((part) => part.type === "tool-show_video" && "output" in part && "отказ" in (part.output as object));
    expect(refused).toHaveLength(1);
  });

  it("следующий ответ снова может показать ролик", async () => {
    const video = await createVideo(database.db, { title: "Ролик", url: "https://kinescope.io/again1", description: "Про повтор." });
    const other = await createVideo(database.db, { title: "Другой ролик", url: "https://kinescope.io/again2", description: "Про другое." });
    await saveDraft(database.db, lead.id, { ...lead.draft, instruction: "Ты консультант превью.", videoIds: [video.id, other.id] }, "manual");
    let id = video.id;
    reply = (call) => (call.lastToolResult !== undefined ? { text: "Вот." } : { toolCalls: [{ toolName: "show_video", input: { id } }] });
    const chatId = await endpoint.restartPreview(lead.id);
    await (await send(chatId, "Покажи ролик")).text();
    id = other.id;
    await (await send(chatId, "А ещё?")).text();

    const answers = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant");
    expect(answers.flatMap((answer) => shownVideosOf(answer.parts).map((shown) => shown.id))).toEqual([video.id, other.id]);
  });
});

describe("тестовый разговор программы на несколько дней", () => {
  const stages = [
    { id: "start", name: "Знакомство", instruction: "Узнай идею.", transitionCondition: "Идея есть", startDay: null, isSale: false },
    { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: 3, isSale: true },
  ];

  beforeEach(async () => {
    await saveDraft(
      database.db,
      lead.id,
      { ...lead.draft, instruction: "Ты консультант превью.", stages, program: newProgramSettings(3) },
      "manual",
    );
  });

  it("день и нода — из сценария: «День 1 из 3» в хвосте, карточка ноды в запросе, факты — в тестовый разговор", async () => {
    reply = (call) =>
      call.lastToolResult !== undefined ? { text: "Записал." } : { toolCalls: [{ toolName: "flow_note", input: { fact: "Делает приложение для кофейни" } }] };
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет")).text();
    expect(calls[0]!.lastUserText).toMatch(/День 1 из 3/);
    expect(JSON.stringify(calls[0]!.options.prompt)).toContain("Узнай идею.");
    expect((await readPreviewConversation(database.db, chatId))?.facts).toEqual(["Делает приложение для кофейни"]);
  });
});

describe("«Следующий день» в тестовом разговоре", () => {
  const stages = [
    { id: "start", name: "Знакомство", instruction: "Узнай идею.", transitionCondition: "Идея есть", startDay: null, isSale: false },
    { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: 2, isSale: true },
  ];

  beforeEach(async () => {
    await saveDraft(
      database.db,
      lead.id,
      { ...lead.draft, instruction: "Ты консультант превью.", stages, program: newProgramSettings(3) },
      "manual",
    );
  });

  it("статус: день и этап у программы; у лидмагнита без неё дня нет", async () => {
    await endpoint.ensurePreview(lead.id);
    expect(await endpoint.status(lead.id)).toMatchObject({ day: 1, days: 3, stageName: "Знакомство" });

    const plain = await createLeadMagnet(database.db, { name: "Без программы" });
    await endpoint.ensurePreview(plain.id);
    expect(await endpoint.status(plain.id)).toMatchObject({ day: null, days: null });
  });

  it("к началу следующего дня: нода сменилась по сроку, бот пишет утреннее сообщение", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Хочу приложение для кофейни")).text();
    await endpoint.flow.settled();
    calls.length = 0;
    reply = () => ({ text: "Доброе утро! Как продвинулась идея?" });
    await endpoint.nextDay(lead.id);
    await endpoint.flow.settled();

    const state = await readPreviewConversation(database.db, chatId);
    expect(state?.currentStageId).toBe("sale");
    // Срок в «Продажу» — таймер SDK «день 2 программы»: переход в начале дня, утреннее уже из «Продажи»
    expect(state?.stageHistory).toEqual([expect.objectContaining({ stageId: "sale", decidedBy: "timer", day: 2 })]);
    expect(await endpoint.status(lead.id)).toMatchObject({ day: 2, stageName: "Продажа" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.lastUserText).toMatch(/День 2 из 3/);
    const messages = await chatStorage.listMessages(chatId);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", status: "complete" });
    expect(JSON.stringify(messages.at(-1)!.parts)).toContain("Доброе утро");

    // «Лог» объясняет утро: переход по дню программы (откуда, куда, кто, день) и почему бот написал первым
    const entries = (await listAgentLog(database.db, lead.id, { limit: 20 })).turns.flatMap((turn) => turn.entries);
    expect(entries.find((entry) => entry.kind === "transition")).toMatchObject({ from: "Знакомство", to: "Продажа", decidedBy: "timer", day: 2, totalDays: 3 });
    expect(entries.find((entry) => entry.kind === "first-message")).toMatchObject({ reasons: expect.arrayContaining([{ kind: "morning" }]) });
  });

  it("к началу следующего дня — и до первого сообщения эксперта: тестовый чат за сценарием с начала", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    expect(await endpoint.status(lead.id)).toMatchObject({ day: 1, stageName: "Знакомство" });
    reply = () => ({ text: "Доброе утро! Как продвинулась идея?" });

    await endpoint.nextDay(lead.id);
    await endpoint.flow.settled();

    expect(await endpoint.status(lead.id)).toMatchObject({ day: 2, stageName: "Продажа" });
    expect(JSON.stringify((await chatStorage.listMessages(chatId)).at(-1)!.parts)).toContain("Доброе утро");
  });

  it("к началу следующего дня до первого сообщения — по поясу браузера эксперта", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    // Пояс, где сейчас 10 утра: по нему день 1 — сегодня, «к началу следующего дня» — день 2
    const morningZone = timeZoneAtHour(10, noonInMoscow.now());
    reply = () => ({ text: "Доброе утро! Как продвинулась идея?" });

    await endpoint.nextDay(lead.id, morningZone);
    await endpoint.flow.settled();

    expect(await endpoint.status(lead.id)).toMatchObject({ day: 2, stageName: "Продажа" });
    const run = await endpoint.flow.readRun(previewOwnerId(chatId), chatId);
    const hourThere = new Intl.DateTimeFormat("en", { timeZone: morningZone, hour: "2-digit", hourCycle: "h23" }).format(run!.day!.dayStartedAt);
    expect(hourThere).toBe("09");
  });

  it("у каждого тестового чата свой счёт сообщений первым: четвёртый перезапуск за день тоже получает утреннее", async () => {
    reply = () => ({ text: "Доброе утро! Как продвинулась идея?" });
    for (let restart = 1; restart <= 4; restart++) {
      const chatId = await endpoint.restartPreview(lead.id);
      await endpoint.nextDay(lead.id);
      await endpoint.flow.settled();
      expect(JSON.stringify(await chatStorage.listMessages(chatId)), `перезапуск ${restart}`).toContain("Доброе утро");
    }
  });

  it("«Начать проверку заново» закрывает сценарий прежнего чата: его сроки и касания больше не идут", async () => {
    const oldChat = await endpoint.ensurePreview(lead.id);
    await (await send(oldChat, "Хочу приложение для кофейни")).text();
    await endpoint.flow.settled();
    expect((await endpoint.flow.readRun(previewOwnerId(oldChat), oldChat))?.endedAt).toBeUndefined();

    const fresh = await endpoint.restartPreview(lead.id);
    await endpoint.flow.settled();

    expect(await endpoint.flow.readRun(previewOwnerId(oldChat), oldChat)).toMatchObject({ endedAt: expect.any(Number) });
    expect((await endpoint.flow.readRun(previewOwnerId(fresh), fresh))?.endedAt).toBeUndefined();
  });

  it("не дальше последнего дня программы: модель не зовётся", async () => {
    await (await send(await endpoint.ensurePreview(lead.id), "Привет")).text();
    await endpoint.nextDay(lead.id);
    await endpoint.nextDay(lead.id);
    calls.length = 0;
    await expect(endpoint.nextDay(lead.id)).rejects.toThrow(/последн/i);
    expect(calls).toHaveLength(0);
  });

  it("после правки сценария перемотка идёт по текущему черновику, как и сообщения", async () => {
    await saveDraft(database.db, lead.id, { ...lead.draft, instruction: "Ты консультант превью.", stages, program: newProgramSettings(2) }, "manual");
    await (await send(await endpoint.ensurePreview(lead.id), "Привет")).text();
    await endpoint.nextDay(lead.id);
    await endpoint.flow.settled();
    await expect(endpoint.nextDay(lead.id)).rejects.toThrow(/последн/i);

    // Эксперт добавил день и сразу жмёт «Следующий день», не написав сообщения
    await saveDraft(database.db, lead.id, { ...lead.draft, instruction: "Ты консультант превью.", stages, program: newProgramSettings(3) }, "manual");
    await endpoint.nextDay(lead.id);
    await endpoint.flow.settled();
    expect(await endpoint.status(lead.id)).toMatchObject({ day: 3, days: 3 });
  });

  it("у лидмагнита без программы и у завершённого разговора — отказ", async () => {
    const plain = await createLeadMagnet(database.db, { name: "Без программы" });
    await endpoint.ensurePreview(plain.id);
    await expect(endpoint.nextDay(plain.id)).rejects.toThrow(/воронк/i);

    const chatId = await endpoint.ensurePreview(lead.id);
    await createPreviewConversationStore(database.db).finish(chatId, { goal: "a", stuckAt: "b", chosenStep: "c" });
    await expect(endpoint.nextDay(lead.id)).rejects.toThrow(/завершён/i);
  });
});

describe("адреса тестового чата для доски: start, advance, run", () => {
  const stages = [
    { id: "start", name: "Знакомство", instruction: "Узнай идею.", transitionCondition: "Идея есть", startDay: null, isSale: false },
    { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: 2, isSale: true },
  ];

  beforeEach(async () => {
    await saveDraft(database.db, lead.id, { ...lead.draft, instruction: "Ты консультант превью.", stages, program: newProgramSettings(3) }, "manual");
  });

  const call = (path: string, body: unknown = {}) =>
    endpoint.fetch(new Request(`http://localhost/api/preview/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("без входа все три адреса — 401, часы не двигаются", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    const advance = vi.spyOn(endpoint.flow, "advanceTestClock");
    signedIn = false;
    expect((await call("flow-test/start", { leadMagnetId: lead.id })).status).toBe(401);
    expect((await call(`${chatId}/flow-test/advance`, { to: "next_day_start" })).status).toBe(401);
    expect((await call(`${chatId}/flow-test/run`)).status).toBe(401);
    expect(advance).not.toHaveBeenCalled();
  });

  it("start: первый раз отдаёт тот же разговор, что и «Проверка»; restart — новый, старый после этого чужой", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    const same = (await (await call("flow-test/start", { leadMagnetId: lead.id })).json()) as { chatId: string };
    expect(same.chatId).toBe(chatId);

    const fresh = (await (await call("flow-test/start", { leadMagnetId: lead.id, restart: true })).json()) as { chatId: string };
    expect(fresh.chatId).not.toBe(chatId);
    expect((await endpoint.status(lead.id))?.chatId).toBe(fresh.chatId);
    expect((await call(`${chatId}/flow-test/run`)).status).toBe(409);
  });

  it("start: нет такого лидмагнита — 404", async () => {
    expect((await call("flow-test/start", { leadMagnetId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await call("flow-test/start", { leadMagnetId: "не-id" })).status).toBe(404);
  });

  it("run: до первого хода — null, после — нода, путь и день", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    expect(await (await call(`${chatId}/flow-test/run`)).json()).toEqual({ run: null });
    await (await send(chatId, "Хочу приложение")).text();
    await endpoint.flow.settled();
    const { run } = (await (await call(`${chatId}/flow-test/run`)).json()) as { run: { state: string; path: unknown[]; day: { day: number; totalDays: number } } };
    expect(run.state).toBe("start");
    expect(run.path.length).toBeGreaterThan(0);
    expect(run.day).toMatchObject({ day: 1, totalDays: 3 });
  });

  it("advance к началу следующего дня: день сменился, возвращается сдвиг часов", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Хочу приложение")).text();
    await endpoint.flow.settled();
    const response = await call(`${chatId}/flow-test/advance`, { to: "next_day_start" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { timeOffset: number }).timeOffset).toBeGreaterThan(0);
    await endpoint.flow.settled();
    expect(await endpoint.status(lead.id)).toMatchObject({ day: 2, stageName: "Продажа" });
  });

  it("advance на время: сдвиг растёт; нелепое время — 400", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Хочу приложение")).text();
    await endpoint.flow.settled();
    const first = (await (await call(`${chatId}/flow-test/advance`, { ms: 20 * 60_000 })).json()) as { timeOffset: number };
    expect(first.timeOffset).toBe(20 * 60_000);
    expect((await call(`${chatId}/flow-test/advance`, { ms: -5 })).status).toBe(400);
    expect((await call(`${chatId}/flow-test/advance`, { ms: 1e15 })).status).toBe(400);
    expect((await call(`${chatId}/flow-test/advance`, {})).status).toBe(400);
  });

  it("advance к следующему дню после последнего дня — 409 с понятным текстом, часы не двигаются", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await endpoint.nextDay(lead.id);
    await endpoint.flow.settled();
    await endpoint.nextDay(lead.id);
    await endpoint.flow.settled();
    expect(await endpoint.status(lead.id)).toMatchObject({ day: 3 });
    const advance = vi.spyOn(endpoint.flow, "advanceTestClock");
    const late = await call(`${chatId}/flow-test/advance`, { to: "next_day_start" });
    expect(late.status).toBe(409);
    expect(JSON.stringify(await late.json())).toMatch(/последний день/);
    expect(advance).not.toHaveBeenCalled();
  });

  it("чужие чаты — 404, часы не двигаются: боевой разговор, чат конструктора, выдуманный id", async () => {
    const advance = vi.spyOn(endpoint.flow, "advanceTestClock");
    // Чат без записи тестового разговора — как боевой чат человека
    await chatStorage.createChat({ id: "live-chat-1", ownerId: "someone", ...STUB_MODEL_CHOICE });
    for (const foreign of ["live-chat-1", "constructor-chat", "no-such-chat"]) {
      expect((await call(`${foreign}/flow-test/advance`, { to: "next_day_start" })).status).toBe(404);
      expect((await call(`${foreign}/flow-test/advance`, { ms: 60_000 })).status).toBe(404);
      expect((await call(`${foreign}/flow-test/run`)).status).toBe(404);
    }
    expect(advance).not.toHaveBeenCalled();
  });

  it("только POST", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    const response = await endpoint.fetch(new Request(`http://localhost/api/preview/${chatId}/flow-test/run`));
    expect(response.status).toBe(405);
  });
});

describe("перемотка тестового разговора на время (+15 мин, +1 ч, своё)", () => {
  const MIN = 60_000;

  it("эксперт ещё не писал: чат закрепляется за сценарием, часы сдвинуты на столько, сколько просили", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    expect(await endpoint.flow.readRun(previewOwnerId(chatId), chatId)).toBeNull();

    await endpoint.advanceBy(lead.id, 15 * MIN);
    await endpoint.flow.settled();

    expect(await endpoint.flow.readRun(previewOwnerId(chatId), chatId)).not.toBeNull();
    const second = await endpoint.advanceBy(lead.id, 60 * MIN);
    expect(second).toBeGreaterThanOrEqual(75 * MIN);
  });

  it("программа не нужна: у лидмагнита без дней перемотка работает", async () => {
    const plain = await createLeadMagnet(database.db, { name: "Без программы" });
    await endpoint.ensurePreview(plain.id);
    await expect(endpoint.advanceBy(plain.id, 15 * MIN)).resolves.toBeGreaterThanOrEqual(15 * MIN);
  });

  it("отказы словами: разговор не начат, завершён, время вне пределов — часы не двигаются", async () => {
    await expect(endpoint.advanceBy(lead.id, 15 * MIN)).rejects.toThrow(/не начат/i);

    await toInbox();
    const chatId = await endpoint.ensurePreview(lead.id);
    const advance = vi.spyOn(endpoint.flow, "advanceTestClock");
    await expect(endpoint.advanceBy(lead.id, 30 * 1000)).rejects.toThrow(/от минуты до года/i);
    await expect(endpoint.advanceBy(lead.id, 366 * 86_400_000)).rejects.toThrow(/от минуты до года/i);
    await expect(endpoint.advanceBy(lead.id, MIN + 0.5)).rejects.toThrow(/от минуты до года/i);

    await createPreviewConversationStore(database.db).finish(chatId, { goal: "a", stuckAt: "b", chosenStep: "c" });
    await expect(endpoint.advanceBy(lead.id, 15 * MIN)).rejects.toThrow(/завершён/i);
    expect(advance).not.toHaveBeenCalled();
  });

  it("лидмагнит не найден — понятная ошибка", async () => {
    await expect(endpoint.advanceBy("00000000-0000-4000-8000-000000000000", 15 * MIN)).rejects.toThrow(/не найден/i);
  });
});

describe("перемотка тестового разговора к следующему напоминанию", () => {
  const withNudge = async () => {
    const current = (await createLeadMagnet(database.db, { name: "Касание" }));
    await saveDraft(database.db, current.id, { ...current.draft, instruction: "Ты консультант превью." }, "manual");
    const saved = (await import("../lead-magnets")).getLeadMagnet;
    const fresh = (await saved(database.db, current.id))!;
    await saveSettings(database.db, current.id, { ...fresh.draft, flow: { ...fresh.draft.flow, nudges: { afterSilence: [{ amount: 15, unit: "min" }] } } }, "manual");
    return current.id;
  };

  it("клиент замолчал, впереди касание: часы встают на него, агент пишет первым", async () => {
    const id = await withNudge();
    const chatId = await endpoint.ensurePreview(id);
    await (await send(chatId, "Привет")).text();
    await endpoint.flow.settled();
    reply = () => ({ text: "Вы тут? Напомню про идею." });

    const result = await endpoint.advanceToNextFirstMessage(id);
    await endpoint.flow.settled();

    expect(result.timeOffset).toBeGreaterThanOrEqual(14 * 60_000);
    expect(result.timeOffset).toBeLessThanOrEqual(16 * 60_000);
    expect(result.reason).toMatchObject({ kind: expect.any(String) });
    expect(JSON.stringify((await chatStorage.listMessages(chatId)).at(-1)!.parts)).toContain("Напомню про идею");
  });

  /** Лидмагнит без касаний и без срока тишины: сам ничего первым не напишет. */
  const withoutNudges = async () => {
    const created = await createLeadMagnet(database.db, { name: "Без касаний" });
    await saveDraft(database.db, created.id, { ...created.draft, instruction: "Ты консультант превью." }, "manual");
    const fresh = (await getLeadMagnet(database.db, created.id))!;
    const { nudges: _nudges, ...flowWithoutNudges } = fresh.draft.flow;
    const states = flowWithoutNudges.states.map((state) => ({ ...state, nudges: "off" as const }));
    await saveSettings(database.db, created.id, { ...fresh.draft, flow: { ...flowWithoutNudges, states } }, "manual");
    return created.id;
  };

  it("впереди ничего нет — отказ с кодом nothing_scheduled, часы не двигаются", async () => {
    const quiet = await withoutNudges();
    const chatId = await endpoint.ensurePreview(quiet);
    await (await send(chatId, "Привет")).text();
    await endpoint.flow.settled();
    await expect(endpoint.advanceToNextFirstMessage(quiet)).rejects.toMatchObject({
      code: "nothing_scheduled",
      message: "Впереди нет запланированных сообщений: агент сейчас первым не напишет",
    });
  });

  it("те же отказы, что у остальной перемотки: не начат, завершён; чат закрепляется за сценарием", async () => {
    await expect(endpoint.advanceToNextFirstMessage(lead.id)).rejects.toThrow(/не начат/i);
    const quiet = await withoutNudges();
    const chatId = await endpoint.ensurePreview(quiet);
    await expect(endpoint.advanceToNextFirstMessage(quiet)).rejects.toMatchObject({ code: "nothing_scheduled" });
    expect(await endpoint.flow.readRun(previewOwnerId(chatId), chatId)).not.toBeNull();
    await createPreviewConversationStore(database.db).finish(chatId, { goal: "a", stuckAt: "b", chosenStep: "c" });
    await expect(endpoint.advanceToNextFirstMessage(quiet)).rejects.toThrow(/завершён/i);
  });

  it("адрес flow-test/advance с to: next_first_message: 200 со сдвигом или 409 nothing_scheduled", async () => {
    const id = await withNudge();
    const chatId = await endpoint.ensurePreview(id);
    await (await send(chatId, "Привет")).text();
    await endpoint.flow.settled();
    const call = (path: string, body: unknown) =>
      endpoint.fetch(new Request(`http://localhost/api/preview/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const ok = await call(`${chatId}/flow-test/advance`, { to: "next_first_message" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { timeOffset: number }).timeOffset).toBeGreaterThanOrEqual(14 * 60_000);
    await endpoint.flow.settled();

    const emptyChat = await endpoint.ensurePreview(await withoutNudges());
    const none = await call(`${emptyChat}/flow-test/advance`, { to: "next_first_message" });
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ error: { kind: "nothing_scheduled" } });
  });
});

describe("права тестового разговора эксперта: пометки приложения", () => {
  const readCapabilities = async (chatId: string) => {
    const response = await endpoint.fetch(new Request(`http://localhost/api/preview/${chatId}`));
    expect(response.status).toBe(200);
    return ((await response.json()) as { capabilities?: Record<string, boolean> }).capabilities;
  };

  it("у тестового чата право appNotices включено: эксперт видит, почему агент заговорил первым", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    expect(await readCapabilities(chatId)).toMatchObject({ appNotices: true, steer: false });
  });
});

describe("«Описание клиентов» консультант не видит", () => {
  it("запрос консультанта с полем и без него одинаков", async () => {
    const before = await endpoint.ensurePreview(lead.id);
    await (await send(before, "Привет")).text();
    const current = (await getLeadMagnet(database.db, lead.id))!;
    await saveSettings(database.db, lead.id, { ...current.draft, clientPortrait: "Владельцы маленьких студий йоги, сомневаются в цене" }, "manual");
    const after = await endpoint.restartPreview(lead.id);
    await (await send(after, "Привет")).text();

    expect(calls).toHaveLength(2);
    const [first, second] = calls.map((call) => call.options);
    expect(second!.tools).toEqual(first!.tools);
    expect(JSON.stringify(second!.prompt)).toBe(JSON.stringify(first!.prompt));
    expect(JSON.stringify(second!.prompt)).not.toContain("студий йоги");
  });
});

describe("пробный ход консультанта (consultantWouldAnswer)", () => {
  const history = [
    { role: "assistant" as const, text: "Здравствуйте! С чем пришли?" },
    { role: "user" as const, text: "Хочу больше учеников" },
    { role: "assistant" as const, text: "Сколько их сейчас?" },
    { role: "user" as const, text: "Пятеро, и все друзья" },
  ];

  /** Чат пробного хода: создаётся в хранилище чатов один раз. */
  const trialChats = () => {
    const created: string[] = [];
    const original = chatStorage.createChat.bind(chatStorage);
    vi.spyOn(chatStorage, "createChat").mockImplementation(async (input) => {
      created.push(input.id);
      return original(input);
    });
    return created;
  };

  it("модель видит историю в ориентации консультанта; итог — текст ответа; ни чата, ни записи не остаётся", async () => {
    const previewChat = await endpoint.ensurePreview(lead.id);
    await (await send(previewChat, "Привет из «Проверки»")).text();
    const previewMessages = (await chatStorage.listMessages(previewChat)).length;
    calls.length = 0;
    const created = trialChats();
    const ended = vi.spyOn(endpoint.flow, "end");
    reply = () => ({ text: "А сколько хотите через полгода?" });

    expect(await endpoint.consultantWouldAnswer({ leadMagnetId: lead.id, history })).toBe("А сколько хотите через полгода?");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain("Ты консультант превью.");
    expect(calls[0]!.lastUserText).toContain("Пятеро, и все друзья");
    const said = calls[0]!.options.prompt.flatMap((message) =>
      message.role === "user" || message.role === "assistant"
        ? message.content.flatMap((part) => (part.type === "text" ? [{ role: message.role, text: part.text }] : []))
        : [],
    );
    expect(said).toEqual(expect.arrayContaining([
      { role: "assistant", text: "Здравствуйте! С чем пришли?" },
      expect.objectContaining({ role: "user", text: expect.stringContaining("Хочу больше учеников") }),
      { role: "assistant", text: "Сколько их сейчас?" },
    ]));

    expect(created).toHaveLength(1);
    const trialChat = created[0]!;
    expect(await chatStorage.getChat(trialChat)).toBeNull();
    expect(await database.db.select().from(previewConversations).where(eq(previewConversations.chatId, trialChat))).toEqual([]);
    // Сценарий одноразового чата кончен: сроки и касания по нему не идут
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ chatId: trialChat, ownerId: previewOwnerId(trialChat) }));

    // «Проверка» не тронута
    const after = (await getLeadMagnet(database.db, lead.id))!;
    expect(after.previewChatId).toBe(previewChat);
    expect(await chatStorage.listMessages(previewChat)).toHaveLength(previewMessages);
  });

  it("ход идёт с ноды stageId: в запросе — её инструкция", async () => {
    const stages = [
      { id: "start", name: "Знакомство", instruction: "Узнай идею.", transitionCondition: "Идея есть", startDay: null, isSale: false },
      { id: "price", name: "Цена", instruction: "Назови цену курса.", transitionCondition: "", startDay: null, isSale: false },
    ];
    await saveDraft(database.db, lead.id, { ...lead.draft, instruction: "Ты консультант превью.", stages }, "manual");
    reply = () => ({ text: "Курс стоит 30 000." });

    expect(await endpoint.consultantWouldAnswer({ leadMagnetId: lead.id, history, stageId: "price" })).toBe("Курс стоит 30 000.");
    const prompt = JSON.stringify(calls.at(-1)!.options.prompt);
    expect(prompt).toContain("Назови цену курса.");
    expect(prompt).not.toContain("Узнай идею.");
  });

  it("сбой модели — null, чат всё равно удалён", async () => {
    const created = trialChats();
    reply = () => {
      throw new Error("модель упала");
    };
    expect(await endpoint.consultantWouldAnswer({ leadMagnetId: lead.id, history })).toBeNull();
    expect(created).toHaveLength(1);
    expect(await chatStorage.getChat(created[0]!)).toBeNull();
    expect(await database.db.select().from(previewConversations).where(eq(previewConversations.chatId, created[0]!))).toEqual([]);
  });
});

describe("«Сохранить как заготовку» у исправленного ответа", () => {
  const correctionOf = async (stageId: string | null, agentRole: "consultant" | "client" = "consultant") => {
    const current = (await getLeadMagnet(database.db, lead.id))!;
    const recorded = await recordCorrection(database.db, {
      leadMagnetId: lead.id,
      source: "preview",
      agentRole,
      chatId: "chat-card",
      editedMessageId: `m-${Math.random()}`,
      editedText: "Это недорого, соглашайтесь.",
      correctedMessageId: `c-${Math.random()}`,
      correctedText: "Понимаю. Есть рассрочка на 3 месяца без переплаты.",
      reason: null,
      answerKind: "reply",
      context: [{ role: "user", text: "Дороговато для меня" }],
      actions: [],
      stageId,
      draftVersionId: current.draftVersionId,
    });
    if (recorded.kind !== "created") throw new Error("правка не записалась");
    return { id: recorded.correction.id, stage: current.draft.flow.states[0]! };
  };

  it("текст — вариант эксперта, этап — где прозвучал ответ, название и повод подсказывает модель", async () => {
    const { stage } = await correctionOf(null);
    const { id } = await correctionOf(stage.id);
    reply = () => ({ text: '{"title":"Дорого","when":"Человек сомневается из-за цены"}' });
    expect(await endpoint.suggestSalesCard(lead.id, id)).toEqual({
      stateId: stage.id,
      title: "Дорого",
      when: "Человек сомневается из-за цены",
      text: "Понимаю. Есть рассрочка на 3 месяца без переплаты.",
      mode: "own_words",
    });
    expect(JSON.stringify(calls.at(-1)!.options.prompt)).toContain("Дороговато для меня");
    expect(calls.at(-1)!.toolNames).toEqual([]);
  });

  it("чужая правка или реплика клиента — нет заготовки", async () => {
    const { id } = await correctionOf(null, "client");
    await expect(endpoint.suggestSalesCard(lead.id, id)).rejects.toThrow();
    await expect(endpoint.suggestSalesCard(lead.id, "00000000-0000-4000-8000-000000000000")).rejects.toThrow();
  });
});

describe("переход в мессенджер в «Проверке»", () => {
  const CONTINUATION = "Продолжаем в мессенджере: на чём остановились?";
  const STAGES = [
    { id: "start", name: "Знакомство", instruction: "Узнай задачу.", transitionCondition: "", startDay: null, isSale: false },
    { id: "messenger", name: "В мессенджере", instruction: "Продолжай в мессенджере.", transitionCondition: "", startDay: null, isSale: false },
  ];

  beforeEach(async () => {
    const settings: LeadMagnetSettings = {
      ...lead.draft,
      instruction: "Ты консультант превью.",
      stages: STAGES,
      messengerHandoff: { enabled: true, when: "Когда человек согласился", how: "", channels: ["telegram", "vk"] },
    };
    const flow = leadMagnetToFlow(settings, []);
    const withEvent = {
      ...flow,
      states: flow.states.map((state) =>
        state.id === "start"
          ? { ...state, exits: [...state.exits, { id: "start_messenger", when: { type: "event", event: "app", name: MESSENGER_HANDOFF_EVENT }, to: "messenger" }] }
          : state,
      ),
    } as typeof flow;
    await saveSettings(database.db, lead.id, { ...settings, flow: withEvent }, "manual");
    reply = (call) => {
      if (call.lastUserText.includes(HANDOFF_NOTICE_MARK)) return { text: CONTINUATION };
      if (call.lastUserText.includes("в мессенджер") && call.toolNames.includes("offer_messenger"))
        return call.lastToolResult === undefined ? { toolCalls: [{ toolName: "offer_messenger", input: {} }] } : { text: "Нажмите кнопку ниже." };
      return { text: "Расскажите подробнее." };
    };
  });

  const offer = async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Давайте в мессенджер")).text();
    // Судья сценария после хода — до счёта вызовов модели
    await endpoint.flow.settled();
    return chatId;
  };

  it("до кнопок разговор идёт обычно; консультант показывает кнопки всех выбранных мессенджеров — публикация не нужна", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    expect((await endpoint.status(lead.id))?.messengerHandoff).toBeNull();
    await (await send(chatId, "Привет")).text();
    expect(calls[0]!.toolNames).toContain("offer_messenger");
    await (await send(chatId, "Давайте в мессенджер")).text();
    expect((await endpoint.status(lead.id))?.messengerHandoff).toEqual({
      state: "offered",
      buttons: [
        { channel: "telegram", title: "Telegram" },
        { channel: "vk", title: "ВКонтакте" },
      ],
    });
  });

  it("после кнопок поле ввода закрыто, как в веб-чате: сообщение получает 409 с подсказкой, модель не зовётся", async () => {
    const chatId = await offer();
    calls.length = 0;
    const response = await send(chatId, "Ещё вопрос");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/кнопк/);
    expect(calls).toHaveLength(0);
  });

  it("нажатие кнопки: событие сценария, консультант продолжает первым без знакомства, дальше разговор как в мессенджере", async () => {
    const chatId = await offer();
    calls.length = 0;
    await endpoint.takeMessengerHandoff(lead.id, "vk");
    await endpoint.flow.settled();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.lastUserText).toContain(HANDOFF_NOTICE_MARK);
    expect(JSON.stringify((await chatStorage.listMessages(chatId)).at(-1)!.parts)).toContain(CONTINUATION);
    expect(await endpoint.status(lead.id)).toMatchObject({ stageName: "В мессенджере", messengerHandoff: { state: "taken", channel: "vk", title: "ВКонтакте" } });

    // Повторное нажатие ничего не меняет
    await endpoint.takeMessengerHandoff(lead.id, "vk");
    await endpoint.flow.settled();
    expect(calls).toHaveLength(1);

    // В мессенджере инструмента перехода нет, сообщения снова принимаются
    const response = await send(chatId, "Продолжим");
    expect(response.status).toBe(200);
    await response.text();
    expect(calls.at(-1)!.toolNames).not.toContain("offer_messenger");
  });

  it("кнопка не того мессенджера или кнопок не было — отказ, разговор не меняется", async () => {
    await endpoint.ensurePreview(lead.id);
    await expect(endpoint.takeMessengerHandoff(lead.id, "telegram")).rejects.toThrow();
    await offer();
    await expect(endpoint.takeMessengerHandoff(lead.id, "max")).rejects.toThrow();
    expect((await endpoint.status(lead.id))?.messengerHandoff).toMatchObject({ state: "offered" });
  });

  it("«Начать проверку заново» — кнопок снова нет", async () => {
    await offer();
    await endpoint.restartPreview(lead.id);
    expect((await endpoint.status(lead.id))?.messengerHandoff).toBeNull();
  });

  it("сбой после нажатия кнопки — кнопки остаются, повторное нажатие доводит продолжение", async () => {
    await offer();
    calls.length = 0;
    const signal = endpoint.flow.signal;
    endpoint.flow.signal = async () => {
      throw new Error("сценарий недоступен");
    };
    try {
      await expect(endpoint.takeMessengerHandoff(lead.id, "telegram")).rejects.toThrow();
    } finally {
      endpoint.flow.signal = signal;
    }
    expect((await endpoint.status(lead.id))?.messengerHandoff).toMatchObject({ state: "offered" });

    await endpoint.takeMessengerHandoff(lead.id, "telegram");
    await endpoint.flow.settled();
    expect(calls).toHaveLength(1);
    expect((await endpoint.status(lead.id))?.messengerHandoff).toMatchObject({ state: "taken", channel: "telegram" });
  });
});

describe("правка в «Проверке» возвращает разговор к месту правки", () => {
  const STAGES = [
    { id: "start", name: "Знакомство", instruction: "Узнай идею.", transitionCondition: "Идея есть", startDay: null, isSale: false },
    { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: 2, isSale: true },
  ];
  const COFFEE = "Делает приложение для кофейни";
  const BAKERY = "Делает сайт для пекарни";
  const summary = { goal: "Курс", stuckAt: "Нет идеи", chosenStep: "Собрать идею", outcome: "agreed" };

  beforeEach(async () => {
    // Карточка «Проверки» общая на все открытые тестовые разговоры: разговоры прошлых тестов закрыты, иначе их факты
    // видны консультанту и считаются уже известными
    await database.pool.query("update app.lead_magnets set preview_chat_id = null where id <> $1", [lead.id]);
    await saveDraft(database.db, lead.id, { ...lead.draft, instruction: "Ты консультант превью.", stages: STAGES, program: newProgramSettings(3) }, "manual");
    // Консультант записывает факт о кофейне и пекарне, по «Беру» завершает разговор; судья и прочие запросы — обычный текст
    reply = (call) => {
      if (!call.toolNames.includes("flow_note")) return { text: "Расскажите подробнее." };
      if (call.lastToolResult !== undefined) return { text: "Записал." };
      if (call.lastUserText.includes("Беру")) return { toolCalls: [{ toolName: "finish_dialog", input: summary }] };
      if (call.lastUserText.includes("пекарн")) return { toolCalls: [{ toolName: "flow_note", input: { fact: BAKERY } }] };
      if (call.lastUserText.includes("кофейн")) return { toolCalls: [{ toolName: "flow_note", input: { fact: COFFEE } }] };
      return { text: "Расскажите подробнее." };
    };
  });

  const userMessages = async (chatId: string) => (await loadBranch(chatId)).filter((message) => message.role === "user");
  const loadBranch = (chatId: string) => loadCurrentBranch(chatStorage, chatId);
  const edit = async (chatId: string, editedMessageId: string, text: string) => {
    const response = await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editedMessageId, message: { id: `m-${++counter}`, role: "user", parts: [{ type: "text", text }] } }),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    await endpoint.flow.settled();
  };
  const regenerate = async (chatId: string, messageId: string) => {
    const response = await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId }),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    await endpoint.flow.settled();
  };
  const say = async (chatId: string, text: string) => {
    await (await send(chatId, text)).text();
    await endpoint.flow.settled();
  };
  /** День 1: факт о кофейне; «Следующий день» — «Продажа» по сроку; день 2: факт о пекарне. */
  const twoDays = async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await say(chatId, "Хочу приложение для кофейни");
    await endpoint.nextDay(lead.id);
    await endpoint.flow.settled();
    await say(chatId, "А ещё сайт для пекарни");
    expect(await endpoint.status(lead.id)).toMatchObject({ day: 2, stageName: "Продажа" });
    expect((await readPreviewConversation(database.db, chatId))?.facts).toEqual([COFFEE, BAKERY]);
    return chatId;
  };
  /** Что консультант видит в последнем ходе. */
  const lastPrompt = () => JSON.stringify(calls.filter((call) => call.toolNames.includes("flow_note")).at(-1)!.options.prompt);

  it("законченный многоэтапный разговор: правка первой реплики — день 1, «Знакомство», фактов после неё нет", async () => {
    const chatId = await twoDays();
    await say(chatId, "Беру");
    expect((await endpoint.status(lead.id))?.finished).toBe(true);
    const [first] = await userMessages(chatId);

    await edit(chatId, first!.id, "Просто смотрю");

    expect(await endpoint.status(lead.id)).toMatchObject({ day: 1, stageName: "Знакомство", finished: false });
    const prompt = lastPrompt();
    expect(prompt).toMatch(/День 1 из 3/);
    expect(prompt).toContain("Узнай идею.");
    expect(prompt).not.toContain("кофейни");
    expect(prompt).not.toContain("пекарни");
    const state = await readPreviewConversation(database.db, chatId);
    expect(state).toMatchObject({ facts: [], finishedAt: null, summary: null });
    expect(state?.stageHistory).toEqual([]);
    const run = await endpoint.flow.readRun(previewOwnerId(chatId), chatId);
    expect(run).toMatchObject({ state: "start", day: { day: 1 } });
  });

  it("правка реплики второго дня в законченном разговоре — тот же день 2 и «Продажа», факт о пекарне забыт", async () => {
    const chatId = await twoDays();
    await say(chatId, "Беру");
    const second = (await userMessages(chatId)).at(-2)!;

    await edit(chatId, second.id, "Пока думаю");

    expect(await endpoint.status(lead.id)).toMatchObject({ day: 2, stageName: "Продажа", finished: false });
    expect((await readPreviewConversation(database.db, chatId))?.facts).toEqual([COFFEE]);
    const prompt = lastPrompt();
    expect(prompt).toMatch(/День 2 из 3/);
    expect(prompt).toContain("кофейни");
    expect(prompt).not.toContain("пекарни");
  });

  it("«Переделать ответ» на первую реплику — разговор там, где был этот ответ: день 1, «Знакомство»", async () => {
    const chatId = await twoDays();
    await say(chatId, "Беру");
    const branch = await loadBranch(chatId);
    const firstUser = branch.findIndex((message) => message.role === "user");
    const answer = branch.slice(firstUser).find((message) => message.role === "assistant")!;

    await regenerate(chatId, answer.id);

    expect(await endpoint.status(lead.id)).toMatchObject({ day: 1, stageName: "Знакомство", finished: false });
    // Ответ переделан на ту же реплику: факт о кофейне записан заново, о пекарне — нет
    expect((await readPreviewConversation(database.db, chatId))?.facts).toEqual([COFFEE]);
    expect(lastPrompt()).toMatch(/День 1 из 3/);
  });

  it("незаконченный разговор: правка первой реплики — тоже откат к дню 1 и «Знакомству»", async () => {
    const chatId = await twoDays();
    const [first] = await userMessages(chatId);

    await edit(chatId, first!.id, "Просто смотрю");

    expect(await endpoint.status(lead.id)).toMatchObject({ day: 1, stageName: "Знакомство", finished: false });
    expect((await readPreviewConversation(database.db, chatId))?.facts).toEqual([]);
    expect(lastPrompt()).not.toContain("пекарни");
  });

  it("повторная правка: после отката разговор идёт дальше, вторая правка возвращает к началу новой ветки", async () => {
    const chatId = await twoDays();
    const [first] = await userMessages(chatId);
    await edit(chatId, first!.id, "Хочу сайт для пекарни");
    expect((await readPreviewConversation(database.db, chatId))?.facts).toEqual([BAKERY]);
    await endpoint.nextDay(lead.id);
    await endpoint.flow.settled();
    expect(await endpoint.status(lead.id)).toMatchObject({ day: 2, stageName: "Продажа" });

    const [again] = await userMessages(chatId);
    await edit(chatId, again!.id, "Просто смотрю");

    expect(await endpoint.status(lead.id)).toMatchObject({ day: 1, stageName: "Знакомство" });
    expect((await readPreviewConversation(database.db, chatId))?.facts).toEqual([]);
  });

  it("служба чата правку не приняла — разговор и часы прежние: день 2, «Продажа», оба факта", async () => {
    const chatId = await twoDays();
    const [first] = await userMessages(chatId);

    const response = await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editedMessageId: first!.id, message: { id: `m-${++counter}`, role: "assistant", parts: [{ type: "text", text: "Не реплика" }] } }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    await response.text();

    expect(await endpoint.status(lead.id)).toMatchObject({ day: 2, stageName: "Продажа" });
    expect((await readPreviewConversation(database.db, chatId))?.facts).toEqual([COFFEE, BAKERY]);
  });

  it("законченный разговор, служба чата правку не приняла — он остаётся законченным, итог на месте", async () => {
    const chatId = await twoDays();
    await say(chatId, "Беру");
    const before = await readPreviewConversation(database.db, chatId);
    expect(before?.finishedAt).not.toBeNull();
    const [first] = await userMessages(chatId);

    const response = await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editedMessageId: first!.id, message: { id: `m-${++counter}`, role: "assistant", parts: [{ type: "text", text: "Не реплика" }] } }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    await response.text();

    expect(await readPreviewConversation(database.db, chatId)).toMatchObject({
      finishedAt: before!.finishedAt,
      summary: before!.summary,
      facts: [COFFEE, BAKERY],
      currentStageId: before!.currentStageId,
    });
    expect(await endpoint.status(lead.id)).toMatchObject({ day: 2, finished: true });
  });

  it("ответ агента ещё идёт — правка получает «занято», разговор и часы не трогаются", async () => {
    const chatId = await twoDays();
    const [first] = await userMessages(chatId);
    // Агент пишет первым, ответ ещё идёт (например, на другой копии сервера): он пишет в тот же тестовый разговор
    const last = (await loadBranch(chatId)).at(-1)!;
    await chatStorage.insertMessage({
      ...last,
      id: `running-${++counter}`,
      parentId: last.id,
      role: "assistant",
      status: "streaming",
      parts: [],
      alive: "now",
      createdAt: new Date().toISOString(),
    });

    const response = await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editedMessageId: first!.id, message: { id: `m-${++counter}`, role: "user", parts: [{ type: "text", text: "Просто смотрю" }] } }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { kind: "busy" } });

    expect(await endpoint.status(lead.id)).toMatchObject({ day: 2, stageName: "Продажа" });
    expect((await readPreviewConversation(database.db, chatId))?.facts).toEqual([COFFEE, BAKERY]);
  });

  it("снимок — на каждый ход тестового разговора, по id ответа; живые разговоры снимков не пишут (их нет в preview_conversations)", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await say(chatId, "Хочу приложение для кофейни");
    const answers = (await loadBranch(chatId)).filter((message) => message.role === "assistant").map((message) => message.id);
    const { rows } = await database.pool.query<{ answer_id: string }>("select answer_id from app.preview_turn_snapshots where chat_id = $1", [chatId]);
    expect(rows.map((row) => row.answer_id).sort()).toEqual(answers.slice(-1));
    const orphans = await database.pool.query(
      "select 1 from app.preview_turn_snapshots s where not exists (select 1 from app.preview_conversations p where p.chat_id = s.chat_id)",
    );
    expect(orphans.rows).toEqual([]);
  });
});

describe("правка в «Проверке» и переход в мессенджер", () => {
  const STAGES = [
    { id: "start", name: "Знакомство", instruction: "Узнай задачу.", transitionCondition: "", startDay: null, isSale: false },
    { id: "messenger", name: "В мессенджере", instruction: "Продолжай в мессенджере.", transitionCondition: "", startDay: null, isSale: false },
  ];

  beforeEach(async () => {
    const settings: LeadMagnetSettings = {
      ...lead.draft,
      instruction: "Ты консультант превью.",
      stages: STAGES,
      messengerHandoff: { enabled: true, when: "Когда человек согласился", how: "", channels: ["telegram", "vk"] },
    };
    const flow = leadMagnetToFlow(settings, []);
    const withEvent = {
      ...flow,
      states: flow.states.map((state) =>
        state.id === "start"
          ? { ...state, exits: [...state.exits, { id: "start_messenger", when: { type: "event", event: "app", name: MESSENGER_HANDOFF_EVENT }, to: "messenger" }] }
          : state,
      ),
    } as typeof flow;
    await saveSettings(database.db, lead.id, { ...settings, flow: withEvent }, "manual");
    reply = (call) => {
      if (call.lastUserText.includes(HANDOFF_NOTICE_MARK)) return { text: "Продолжаем в мессенджере." };
      if (call.lastUserText.includes("в мессенджер") && call.toolNames.includes("offer_messenger"))
        return call.lastToolResult === undefined ? { toolCalls: [{ toolName: "offer_messenger", input: {} }] } : { text: "Нажмите кнопку ниже." };
      return { text: "Расскажите подробнее." };
    };
  });

  /** «Привет» → «Давайте в мессенджер» (кнопки) → нажата ВКонтакте → «Продолжим». */
  const afterHandoff = async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    for (const text of ["Привет", "Давайте в мессенджер"]) {
      await (await send(chatId, text)).text();
      await endpoint.flow.settled();
    }
    await endpoint.takeMessengerHandoff(lead.id, "vk");
    await endpoint.flow.settled();
    await (await send(chatId, "Продолжим")).text();
    await endpoint.flow.settled();
    const users = (await loadCurrentBranch(chatStorage, chatId)).filter((message) => message.role === "user" && JSON.stringify(message.parts).includes('"text"'));
    return { chatId, users };
  };
  const edit = async (chatId: string, editedMessageId: string, text: string) => {
    const response = await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editedMessageId, message: { id: `m-${++counter}`, role: "user", parts: [{ type: "text", text }] } }),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    await endpoint.flow.settled();
  };

  it("правка реплики до кнопок: кнопок и перехода нет, этап — «Знакомство»", async () => {
    const { chatId, users } = await afterHandoff();
    const hello = users.find((message) => JSON.stringify(message.parts).includes("Привет"))!;

    await edit(chatId, hello.id, "Здравствуйте");

    expect(await endpoint.status(lead.id)).toMatchObject({ stageName: "Знакомство", messengerHandoff: null });
  });

  it("правка реплики после перехода: переход остаётся, этап — «В мессенджере»", async () => {
    const { chatId, users } = await afterHandoff();
    const later = users.find((message) => JSON.stringify(message.parts).includes("Продолжим"))!;

    await edit(chatId, later.id, "Продолжаем");

    expect(await endpoint.status(lead.id)).toMatchObject({ stageName: "В мессенджере", messengerHandoff: { state: "taken", channel: "vk" } });
  });
});

describe("запись на созвон в «Проверке»", () => {
  const STAGES = [
    { id: "start", name: "Знакомство", instruction: "Узнай задачу.", transitionCondition: "", startDay: null, isSale: false },
    { id: "booked", name: "Записан", instruction: "Человек записан.", transitionCondition: "", startDay: null, isSale: false },
  ];
  const callBooking = { enabled: true, when: "Когда человек хочет разобрать задачу с экспертом", about: "Созвон в зуме", meetingLink: "https://meet.test/expert" };
  const toolOutput = (call: ScriptedCall) => (call.lastToolResult as { value?: { slots?: Array<{ start: string }>; ok?: boolean } } | undefined)?.value;

  const saveWithCallBooking = async (setting: LeadMagnetSettings["callBooking"]) => {
    const settings: LeadMagnetSettings = { ...lead.draft, instruction: "Ты консультант превью.", stages: STAGES, ...(setting && { callBooking: setting }) };
    const flow = leadMagnetToFlow(settings, []);
    const withEvent = {
      ...flow,
      states: flow.states.map((state) =>
        state.id === "start" ? { ...state, exits: [...state.exits, { id: "start_booked", when: { type: "event", event: "app", name: CALL_BOOKED_EVENT }, to: "booked" }] } : state,
      ),
    } as typeof flow;
    await saveSettings(database.db, lead.id, { ...settings, flow: withEvent }, "manual");
  };

  beforeEach(async () => {
    await database.pool.query("delete from app.call_notices; delete from app.call_bookings; delete from app.call_windows; delete from app.call_calendar");
    const now = noonInMoscow.now();
    await updateCallCalendar(database.db, { timeZone: "Europe/Moscow", callMinutes: 30 }, { now, confirm: true });
    await saveCallWindow(database.db, { date: localDate(now, "Europe/Moscow"), startTime: "00:00", endTime: "23:30", weekly: true }, { now, confirm: true });
    reply = (call) => {
      if (!call.lastUserText.includes("созвон") || !call.toolNames.includes("book_call")) return { text: "Расскажите подробнее." };
      if (call.lastToolResult === undefined) return { toolCalls: [{ toolName: "call_free_times", input: {} }] };
      const slots = toolOutput(call)?.slots;
      if (slots) return { toolCalls: [{ toolName: "book_call", input: { start: slots[0]!.start } }] };
      return { text: "Записал." };
    };
  });

  it("инструменты записи есть, только когда настройка включена", async () => {
    await saveWithCallBooking(undefined);
    await (await send(await endpoint.ensurePreview(lead.id), "Привет")).text();
    expect(calls.at(-1)!.toolNames).not.toContain("call_free_times");

    await saveWithCallBooking({ ...callBooking, enabled: false });
    await endpoint.restartPreview(lead.id);
    await (await send(await endpoint.ensurePreview(lead.id), "Привет")).text();
    expect(calls.at(-1)!.toolNames).not.toContain("book_call");

    await saveWithCallBooking(callBooking);
    await endpoint.restartPreview(lead.id);
    await (await send(await endpoint.ensurePreview(lead.id), "Привет")).text();
    expect(calls.at(-1)!.toolNames).toEqual(expect.arrayContaining(["call_free_times", "book_call", "change_call"]));
  });

  it("запись тестовая: окно не занято, уведомлений нет, эксперт видит её в статусе, сценарий получает событие", async () => {
    await saveWithCallBooking(callBooking);
    const chatId = await endpoint.ensurePreview(lead.id);
    const freeBefore = (await freeCallTimes(database.db, { now: noonInMoscow.now() })).slots.length;
    await (await send(chatId, "Хочу на созвон")).text();
    await endpoint.flow.settled();

    const { rows } = await database.pool.query("select test_chat_id, person_id, meeting_link from app.call_bookings");
    expect(rows).toEqual([{ test_chat_id: chatId, person_id: null, meeting_link: "https://meet.test/expert" }]);
    expect((await database.pool.query("select 1 from app.call_notices")).rowCount).toBe(0);
    expect((await freeCallTimes(database.db, { now: noonInMoscow.now() })).slots).toHaveLength(freeBefore);
    expect(await endpoint.status(lead.id)).toMatchObject({ callBooking: { label: expect.stringContaining("UTC+3"), meetingLink: "https://meet.test/expert" } });

    // Переход по событию — в начале следующего хода
    await (await send(chatId, "Спасибо")).text();
    expect(await endpoint.status(lead.id)).toMatchObject({ stageName: "Записан" });
  });

  const userMessageWith = async (chatId: string, text: string) =>
    (await loadCurrentBranch(chatStorage, chatId)).find((message) => message.role === "user" && JSON.stringify(message.parts).includes(text))!;
  const editMessage = async (chatId: string, editedMessageId: string, text: string) => {
    const response = await endpoint.fetch(
      new Request(`http://localhost/api/preview/${chatId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editedMessageId, message: { id: `m-${++counter}`, role: "user", parts: [{ type: "text", text }] } }),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    await endpoint.flow.settled();
  };
  const testBookingsOf = async (chatId: string) =>
    (await database.pool.query<{ status: string }>("select status from app.call_bookings where test_chat_id = $1", [chatId])).rows.map((row) => row.status);

  it("правка реплики до записи: тестовой записи нет, консультант может записать заново", async () => {
    await saveWithCallBooking(callBooking);
    const chatId = await endpoint.ensurePreview(lead.id);
    for (const text of ["Хочу на созвон", "Спасибо"]) {
      await (await send(chatId, text)).text();
      await endpoint.flow.settled();
    }
    expect(await testBookingsOf(chatId)).toEqual(["booked"]);

    await editMessage(chatId, (await userMessageWith(chatId, "Хочу на созвон")).id, "Привет");

    expect(await testBookingsOf(chatId)).toEqual([]);
    expect(await endpoint.status(lead.id)).toMatchObject({ callBooking: null, stageName: "Знакомство" });
    await (await send(chatId, "А теперь запишите на созвон")).text();
    expect(await testBookingsOf(chatId)).toEqual(["booked"]);
  });

  it("правка реплики после записи: запись остаётся", async () => {
    await saveWithCallBooking(callBooking);
    const chatId = await endpoint.ensurePreview(lead.id);
    for (const text of ["Хочу на созвон", "Спасибо"]) {
      await (await send(chatId, text)).text();
      await endpoint.flow.settled();
    }

    await editMessage(chatId, (await userMessageWith(chatId, "Спасибо")).id, "Благодарю");

    expect(await testBookingsOf(chatId)).toEqual(["booked"]);
    expect(await endpoint.status(lead.id)).toMatchObject({ callBooking: { meetingLink: "https://meet.test/expert" } });
  });

  it("«Начать проверку заново» — тестовой записи нет", async () => {
    await saveWithCallBooking(callBooking);
    await (await send(await endpoint.ensurePreview(lead.id), "Хочу на созвон")).text();
    await endpoint.restartPreview(lead.id);
    expect((await endpoint.status(lead.id))?.callBooking).toBeNull();
  });
});
