import { createInMemoryChatStorage, loadCurrentBranch, type ChatStorage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createClock } from "../platform/clock";
import { leadMagnetToFlow } from "../flows/settings-to-flow";
import { createLeadMagnet, getLeadMagnet, newProgramSettings, saveDraft as saveSettings, type LeadMagnet, type LeadMagnetSettings } from "../lead-magnets";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "../platform/scripted-model";
import { listCorrections, resolveCorrections, type AnswerCorrection } from "../corrections";
import { createPreviewCorrections } from "./preview-corrections";
import { createPreviewEndpoint, type PreviewEndpoint } from "./preview-endpoint";
import { createPreviewConversationStore, readPreviewConversation } from "./preview-store";

let database: TestDatabase;
let chatStorage: ChatStorage;
let endpoint: PreviewEndpoint;
let lead: LeadMagnet;
let signedIn: boolean;
let reply: (call: ScriptedCall) => ScriptedReply;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

// Дни программы зависят от часа: часы тестов сдвинуты на полдень по Москве
const DAY_MS = 86_400_000;
const shiftToNoon = 12 * 3_600_000 - ((Date.now() + 3 * 3_600_000) % DAY_MS);
const noonInMoscow = createClock(() => new Date(Date.now() + shiftToNoon));

const stages = [
  { id: "start", name: "Знакомство", instruction: "Узнай идею.", transitionCondition: "Идея есть", startDay: null, isSale: false },
  { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: 3, isSale: true },
];

/** Черновик из старых полей — со сценарием из них, как при переводе настроек. */
const saveDraft = (id: string, settings: LeadMagnetSettings) => saveSettings(database.db, id, { ...settings, flow: leadMagnetToFlow(settings, []) }, "manual");

beforeEach(async () => {
  await database.pool.query(
    "do $$ begin if to_regclass('agent_chat.flow_chats') is not null then delete from agent_chat.flow_chats; delete from agent_chat.flow_first_messages; end if; end $$",
  );
  chatStorage = createInMemoryChatStorage();
  signedIn = true;
  reply = () => ({ text: "Расскажите подробнее." });
  const scripted = createScriptedModel((call) => reply(call));
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
  const created = await createLeadMagnet(database.db, { name: "Правки" });
  await saveDraft(created.id, { ...created.draft, instruction: "Ты консультант превью.", firstMessage: "Здравствуйте! Что за курс?", stages, program: newProgramSettings(3) });
  lead = (await getLeadMagnet(database.db, created.id))!;
});

let counter = 0;
const send = (chatId: string, text: string) =>
  endpoint.fetch(
    new Request(`http://localhost/api/preview/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: `corr-m-${++counter}-${Date.now()}`, role: "user", parts: [{ type: "text", text }] } }),
    }),
  );

const editAnswer = async (chatId: string, messageId: string, text: string, data?: Record<string, unknown>) => {
  const response = await endpoint.fetch(
    new Request(`http://localhost/api/preview/${chatId}/messages/${messageId}/answer-edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...(data && { data }) }),
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { messageId: string }).messageId;
};

const labels = (chatId: string) => endpoint.fetch(new Request(`http://localhost/api/preview/${chatId}/corrections`));
const removeCorrection = (chatId: string, correctionId: string) =>
  endpoint.fetch(new Request(`http://localhost/api/preview/${chatId}/corrections/${correctionId}`, { method: "DELETE" }));

const lastAnswer = async (chatId: string) => (await loadCurrentBranch(chatStorage, chatId)).filter((message) => message.role === "assistant").at(-1)!;

/** Хук правки идёт после ответа на запрос: ждём, пока правок станет `count`. */
async function correctionsSettled(count: number): Promise<AnswerCorrection[]> {
  let corrections: AnswerCorrection[] = [];
  await vi.waitFor(
    async () => {
      corrections = await listCorrections(database.db, lead.id, { status: "all" });
      expect(corrections).toHaveLength(count);
    },
    { timeout: 5000 },
  );
  return corrections;
}

describe("«Поправить» в «Проверке»: хук правки", () => {
  it("записывает правку: кусок разговора, нода, день, версия черновика, действия, причина", async () => {
    reply = (call) =>
      call.lastToolResult !== undefined ? { text: "Записал. А кто ваши ученики?" } : { toolCalls: [{ toolName: "flow_note", input: { fact: "Курс по керамике" } }] };
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Курс по керамике")).text();
    const answer = await lastAnswer(chatId);

    const corrected = await editAnswer(chatId, answer.id, "Керамика — здорово. Кому он нужен?", { reason: "Короче и теплее" });

    const [correction] = await correctionsSettled(1);
    expect(correction).toMatchObject({
      source: "preview",
      agentRole: "consultant",
      chatId,
      originalMessageId: answer.id,
      correctedMessageId: corrected,
      answerKind: "reply",
      originalText: "Записал. А кто ваши ученики?",
      correctedText: "Керамика — здорово. Кому он нужен?",
      reason: "Короче и теплее",
      stageId: "start",
      programDay: 1,
      draftVersionId: lead.draftVersionId,
      status: "pending",
    });
    expect(correction!.context.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "assistant", text: "Здравствуйте! Что за курс?" },
      { role: "user", text: "Курс по керамике" },
    ]);
    expect(correction!.actions).toEqual(["записал факт о человеке"]);
  });

  it("ответ с кнопками готовых ответов правится как обычный: правка записана, кнопки в действия не попадают", async () => {
    reply = (call) =>
      call.lastToolResult !== undefined
        ? {}
        : { text: "Как удобнее продолжить?", toolCalls: [{ toolName: "suggest_replies", input: { replies: ["Созвон", "Переписка"] } }] };
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Курс по керамике")).text();
    const answer = await lastAnswer(chatId);
    expect(answer.parts.some((part) => part.type === "tool-suggest_replies")).toBe(true);

    const corrected = await editAnswer(chatId, answer.id, "Удобнее созвониться или переписываться?");

    const [correction] = await correctionsSettled(1);
    expect(correction).toMatchObject({
      originalMessageId: answer.id,
      correctedMessageId: corrected,
      answerKind: "reply",
      originalText: "Как удобнее продолжить?",
      correctedText: "Удобнее созвониться или переписываться?",
    });
    expect(correction!.actions).toEqual([]);
  });

  it("первое сообщение лидмагнита — вид first_message", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    const first = await lastAnswer(chatId);

    await editAnswer(chatId, first.id, "Добрый день! Расскажите о курсе.");

    const [correction] = await correctionsSettled(1);
    expect(correction).toMatchObject({ answerKind: "first_message", originalText: "Здравствуйте! Что за курс?", context: [] });
  });

  it("ответ с прощанием приложения — вид farewell", async () => {
    await saveDraft(lead.id, { ...lead.draft, farewellMessage: "Удачи с курсом!" });
    reply = (call) =>
      call.lastToolResult !== undefined
        ? {}
        : { toolCalls: [{ toolName: "finish_dialog", input: { goal: "Курс", stuckAt: "Нет идеи", chosenStep: "Собрать идею", outcome: "agreed" } }] };
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Да, подходит")).text();
    const answer = await lastAnswer(chatId);

    await editAnswer(chatId, answer.id, "Рад был помочь. Удачи с курсом!");

    const [correction] = await correctionsSettled(1);
    expect(correction).toMatchObject({ answerKind: "farewell", originalText: "Удачи с курсом!" });
    expect(correction!.actions).toContain("завершил разговор");
  });

  it("повторная правка обновляет «стало», возврат к исходному тексту удаляет правку", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет")).text();
    const answer = await lastAnswer(chatId);

    const first = await editAnswer(chatId, answer.id, "Привет! Что за курс?", { reason: "Короче" });
    await correctionsSettled(1);
    const second = await editAnswer(chatId, first, "Привет! О чём курс?");
    await vi.waitFor(async () => expect((await listCorrections(database.db, lead.id))[0]?.correctedMessageId).toBe(second));
    const [updated] = await listCorrections(database.db, lead.id);
    expect(updated).toMatchObject({ originalMessageId: answer.id, originalText: "Расскажите подробнее.", correctedText: "Привет! О чём курс?", reason: "Короче" });

    await editAnswer(chatId, second, "Расскажите подробнее.");
    await correctionsSettled(0);
  });

  it("завершённый разговор принимает правку и остаётся завершённым", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет")).text();
    await createPreviewConversationStore(database.db).finish(chatId, { goal: "a", stuckAt: "b", chosenStep: "c" });
    const answer = await lastAnswer(chatId);

    await editAnswer(chatId, answer.id, "Хорошо, до связи.");

    await correctionsSettled(1);
    expect((await readPreviewConversation(database.db, chatId))?.finishedAt).toBeTruthy();
    expect((await endpoint.status(lead.id))?.finished).toBe(true);
  });

  it("версия черновика — та, на которой прозвучал ответ, а не та, что стала к правке", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет")).text();
    const answer = await lastAnswer(chatId);
    await saveDraft(lead.id, { ...lead.draft, instruction: "Ты консультант превью, версия 2." });

    await editAnswer(chatId, answer.id, "Привет! О чём курс?");

    const [correction] = await correctionsSettled(1);
    expect(correction!.draftVersionId).toBe(lead.draftVersionId);
  });

  it("правка остаётся после «Начать проверку заново»", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет")).text();
    await editAnswer(chatId, (await lastAnswer(chatId)).id, "Привет! О чём курс?");
    await correctionsSettled(1);

    await endpoint.restartPreview(lead.id);

    expect(await listCorrections(database.db, lead.id)).toHaveLength(1);
  });

  it("правка, которую хук не записал (сервер упал), дозаписывается при чтении меток — один раз", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет")).text();
    const answer = await lastAnswer(chatId);
    const corrected = await editAnswer(chatId, answer.id, "Привет! О чём курс?", { reason: "Короче" });
    await correctionsSettled(1);
    // Как будто процесс упал до хука: правка есть только в ленте чата
    await database.pool.query("delete from app.answer_edit_receipts where chat_id = $1", [chatId]);
    await database.pool.query("delete from app.answer_corrections where chat_id = $1", [chatId]);

    expect((await labels(chatId)).status).toBe(200);
    expect((await labels(chatId)).status).toBe(200);

    const corrections = await listCorrections(database.db, lead.id);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ originalMessageId: answer.id, correctedMessageId: corrected, correctedText: "Привет! О чём курс?", reason: "Короче" });
  });

  it("сбой записи одной правки при сверке не мешает остальным и меткам; при следующем чтении она дозаписывается", async () => {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет")).text();
    const firstCorrected = await editAnswer(chatId, (await lastAnswer(chatId)).id, "Привет! О чём курс?");
    await (await send(chatId, "Про керамику")).text();
    const secondCorrected = await editAnswer(chatId, (await lastAnswer(chatId)).id, "Керамика — здорово.");
    await correctionsSettled(2);
    await database.pool.query("delete from app.answer_edit_receipts where chat_id = $1", [chatId]);
    await database.pool.query("delete from app.answer_corrections where chat_id = $1", [chatId]);
    // Чтение ветки чата падает один раз — как временный сбой базы на первой правке
    let failures = 1;
    const flaky: ChatStorage = Object.create(chatStorage, {
      listBranchSelections: {
        value: (id: string) => (failures-- > 0 ? Promise.reject(new Error("временный сбой")) : chatStorage.listBranchSelections(id)),
      },
    });
    const corrections = createPreviewCorrections({
      db: database.db,
      chatStorage: flaky,
      leadOfChat: async () => lead,
      readRun: async () => null,
      serviceOfChat: () => Promise.reject(new Error("не нужен")),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const edited = await corrections.editedAnswers(lead, chatId);

    expect(edited.map((answer) => answer.messageId)).toEqual([secondCorrected]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    expect((await corrections.editedAnswers(lead, chatId)).map((answer) => answer.messageId).sort()).toEqual([firstCorrected, secondCorrected].sort());
  });
});

describe("метки и «Убрать правку»", () => {
  async function editedChat() {
    const chatId = await endpoint.ensurePreview(lead.id);
    await (await send(chatId, "Привет")).text();
    const answer = await lastAnswer(chatId);
    const corrected = await editAnswer(chatId, answer.id, "Привет! О чём курс?");
    const [correction] = await correctionsSettled(1);
    return { chatId, answer, corrected, correction: correction! };
  }

  it("GET …/corrections — исправленные ответы чата", async () => {
    const { chatId, corrected, correction } = await editedChat();
    const response = await labels(chatId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ edited: [{ messageId: corrected, correctionId: correction.id, pending: true }] });
  });

  it("DELETE удаляет правку и возвращает исходный ответ; повторное чтение меток её не возвращает", async () => {
    const { chatId, answer, correction } = await editedChat();

    expect((await removeCorrection(chatId, correction.id)).status).toBe(204);

    expect((await lastAnswer(chatId)).id).toBe(answer.id);
    expect(await listCorrections(database.db, lead.id, { status: "all" })).toHaveLength(0);
    expect(await (await labels(chatId)).json()).toEqual({ edited: [] });
    expect(await listCorrections(database.db, lead.id, { status: "all" })).toHaveLength(0);
  });

  it("разобранную правку не убрать — 409", async () => {
    const { chatId, correction } = await editedChat();
    await resolveCorrections(database.db, lead.id, [correction.id], "rejected");
    expect((await removeCorrection(chatId, correction.id)).status).toBe(409);
    expect(await (await labels(chatId)).json()).toEqual({ edited: [{ messageId: correction.correctedMessageId, correctionId: correction.id, pending: false }] });
  });

  it("повторная правка разобранного ответа: «Убрать правку» возвращает ответ, который правили, а не самый первый", async () => {
    const { chatId, corrected, correction } = await editedChat();
    await resolveCorrections(database.db, lead.id, [correction.id], "rejected");
    await editAnswer(chatId, corrected, "Привет! Про что курс?");
    await correctionsSettled(2);
    const [pending] = await listCorrections(database.db, lead.id);

    expect((await removeCorrection(chatId, pending!.id)).status).toBe(204);

    expect((await lastAnswer(chatId)).id).toBe(corrected);
  });

  it("чужой чат — 404", async () => {
    const { correction } = await editedChat();
    expect((await labels("нет-такого-чата")).status).toBe(404);
    expect((await removeCorrection("нет-такого-чата", correction.id)).status).toBe(404);

    const other = await createLeadMagnet(database.db, { name: "Другой" });
    const otherChat = await endpoint.ensurePreview(other.id);
    expect((await removeCorrection(otherChat, correction.id)).status).toBe(404);
    expect(await listCorrections(database.db, lead.id)).toHaveLength(1);
  });

  it("без входа — 401", async () => {
    const { chatId, correction } = await editedChat();
    signedIn = false;
    expect((await labels(chatId)).status).toBe(401);
    expect((await removeCorrection(chatId, correction.id)).status).toBe(401);
  });
});
