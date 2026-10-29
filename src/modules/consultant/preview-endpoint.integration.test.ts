import { createInMemoryChatStorage, type ChatStorage } from "@ykurilov/agent-chat-core";
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
import { createPreviewEndpoint, type PreviewEndpoint } from "./preview-endpoint";
import { createPreviewConversationStore, readPreviewConversation } from "./preview-store";
import { previewConversations } from "./schema";

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
  });
  const created = await createLeadMagnet(database.db, { name: "Превью" });
  await saveDraft(database.db, created.id, { ...created.draft, instruction: "Ты консультант превью." }, "manual");
  lead = created;
});

/** Черновик из старых полей (инструкция, этапы, программа) — со сценарием из них, как при переводе настроек. */
const saveDraft = (db: typeof database.db, id: string, settings: LeadMagnetSettings, by: "manual") =>
  saveSettings(db, id, { ...settings, flow: leadMagnetToFlow(settings, []) }, by);

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
  it("завершённый разговор — 409 с понятным текстом", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await createPreviewConversationStore(database.db).finish(chatId, { goal: "a", stuckAt: "b", chosenStep: "c" });
    const response = await send(chatId, "Привет");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/завершён.*«Начать проверку заново»/);
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

  it("не дальше последнего дня программы: модель не зовётся", async () => {
    await (await send(await endpoint.ensurePreview(lead.id), "Привет")).text();
    await endpoint.nextDay(lead.id);
    await endpoint.nextDay(lead.id);
    calls.length = 0;
    await expect(endpoint.nextDay(lead.id)).rejects.toThrow(/последн/i);
    expect(calls).toHaveLength(0);
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

    const chatId = await endpoint.ensurePreview(lead.id);
    const advance = vi.spyOn(endpoint.flow, "advanceTestClock");
    await expect(endpoint.advanceBy(lead.id, 30 * 1000)).rejects.toThrow(/от минуты до 30 суток/i);
    await expect(endpoint.advanceBy(lead.id, 31 * 86_400_000)).rejects.toThrow(/от минуты до 30 суток/i);
    await expect(endpoint.advanceBy(lead.id, MIN + 0.5)).rejects.toThrow(/от минуты до 30 суток/i);

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
