import { createInMemoryChatStorage, loadCurrentBranch, type ChatStorage, type ModelChoice, type StoredMessage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { listCorrections, resolveCorrections, type AnswerCorrection } from "../corrections";
import { createLeadMagnet, getLeadMagnet, saveDraft, type LeadMagnet } from "../lead-magnets";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "../platform/scripted-model";
import { CLIENT_LEAVE_TOOL, clientInstructions } from "./client-agent";
import type { ConsultantTrialInput } from "../consultant";
import { leadMagnetToFlow } from "../flows/settings-to-flow";
import { eq, sql } from "drizzle-orm";
import { conversationOfChat, currentConversation, setReview } from "./conversations";
import { roleSwapConversations } from "./schema";
import { createRoleSwapEndpoint, type RoleSwapEndpoint, type RoleSwapJudge } from "./endpoint";

let database: TestDatabase;
let chatStorage: ChatStorage;
let endpoint: RoleSwapEndpoint;
let lead: LeadMagnet;
let signedIn: boolean;
let choice: ModelChoice;
let clientReply: (call: ScriptedCall) => ScriptedReply;
let calls: ScriptedCall[];
let trial: (input: ConsultantTrialInput) => Promise<string | null>;
let trials: ConsultantTrialInput[];
let judge: RoleSwapJudge;
let judged: Parameters<RoleSwapJudge>[0][];

const FIRST_MESSAGE = "Здравствуйте! Какой велосипед ищете?";
const CARD = "Ольга, 42 года, хочет ездить на работу, боится переплатить.";

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  chatStorage = createInMemoryChatStorage();
  signedIn = true;
  choice = STUB_MODEL_CHOICE;
  clientReply = () => ({ text: "Ну, для города что-нибудь." });
  // Ход клиента видит инструмент ухода; без него — запрос карточки
  const scripted = createScriptedModel((call) => (call.toolNames.includes(CLIENT_LEAVE_TOOL) ? clientReply(call) : { text: CARD }));
  calls = scripted.calls;
  trials = [];
  trial = async (input) => `Консультант ответил бы на «${input.history.at(-1)!.text}»`;
  judged = [];
  judge = async (input) => ({ stateId: input.stateId, transitions: [], status: "checked" });
  endpoint = createRoleSwapEndpoint({
    db: database.db,
    chatStorage,
    catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
    env: { STUB_MODEL_API_KEY: "test" },
    resolveUser: async () => (signedIn ? { id: "expert" } : null),
    modelChoice: () => choice,
    consultantWouldAnswer: (input) => {
      trials.push(input);
      return trial(input);
    },
    judgeExchange: (input) => {
      judged.push(input);
      return judge(input);
    },
  });
  const created = await createLeadMagnet(database.db, { name: "Как выбрать велосипед" });
  await saveDraft(database.db, created.id, { ...created.draft, cardDescription: "Подбор под рост и бюджет", firstMessage: FIRST_MESSAGE }, "manual");
  lead = (await getLeadMagnet(database.db, created.id))!;
});

const clientCalls = () => calls.filter((call) => call.toolNames.includes(CLIENT_LEAVE_TOOL));

async function started(brief: string | null = null): Promise<string> {
  const result = await endpoint.start(lead.id, brief);
  if (!("chatId" in result)) throw new Error(`Разговор не начат: ${result.error}`);
  return result.chatId;
}

/** Ход клиента идёт после ответа на запрос: ждём, пока последней на ветке станет готовая реплика клиента. */
async function clientAnswered(chatId: string, count: number): Promise<StoredMessage[]> {
  let branch: StoredMessage[] = [];
  await vi.waitFor(
    async () => {
      branch = [...(await loadCurrentBranch(chatStorage, chatId))];
      const answers = branch.filter((message) => message.role === "assistant");
      expect(answers).toHaveLength(count);
      expect(answers.at(-1)?.status).toBe("complete");
    },
    { timeout: 5000 },
  );
  return branch;
}

let counter = 0;
const send = (chatId: string, text: string, id = `rs-m-${++counter}-${Date.now()}`) =>
  endpoint.fetch(
    new Request(`http://localhost/api/role-swap/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id, role: "user", parts: [{ type: "text", text }] } }),
    }),
  );

const editAnswer = async (chatId: string, messageId: string, text: string, data?: Record<string, unknown>) => {
  const response = await endpoint.fetch(
    new Request(`http://localhost/api/role-swap/${chatId}/messages/${messageId}/answer-edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...(data && { data }) }),
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { messageId: string }).messageId;
};

const labels = (chatId: string) => endpoint.fetch(new Request(`http://localhost/api/role-swap/${chatId}/corrections`));
const removeCorrection = (chatId: string, correctionId: string) =>
  endpoint.fetch(new Request(`http://localhost/api/role-swap/${chatId}/corrections/${correctionId}`, { method: "DELETE" }));

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

describe("«Поменяемся ролями»: старт", () => {
  it("без первого сообщения лидмагнита разговор не начинается", async () => {
    await saveDraft(database.db, lead.id, { ...lead.draft, firstMessage: "  " }, "manual");
    expect(await endpoint.start(lead.id, null)).toEqual({ error: "no_first_message" });
    expect(await currentConversation(database.db, lead.id)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("карточка клиента, чат на модели консультанта, первое сообщение лидмагнита — репликой эксперта, клиент отвечает", async () => {
    const chatId = await started("Студент без денег");

    const conversation = await conversationOfChat(database.db, chatId);
    expect(conversation).toMatchObject({ leadMagnetId: lead.id, clientBrief: "Студент без денег", clientCard: CARD, status: "active" });
    expect(conversation!.topic).toContain(lead.draft.name);
    expect(conversation!.topic).toContain("Подбор под рост и бюджет");
    expect(await chatStorage.getChat(chatId)).toMatchObject({ modelId: STUB_MODEL_CHOICE.modelId, providerId: STUB_MODEL_CHOICE.providerId });

    const branch = await clientAnswered(chatId, 1);
    expect(branch.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(branch[0]!.parts).toEqual([{ type: "text", text: FIRST_MESSAGE }]);

    const [turn] = clientCalls();
    expect(turn!.system).toContain(clientInstructions());
    const prompt = JSON.stringify(turn!.options.prompt);
    expect(prompt).toContain(CARD);
    expect(prompt).toContain("Подбор под рост и бюджет");
    expect(turn!.toolNames).toEqual([CLIENT_LEAVE_TOOL]);
  });

  it("пустое «Кто клиент» хранится как его нет", async () => {
    const chatId = await started("   ");
    expect((await conversationOfChat(database.db, chatId))?.clientBrief).toBeNull();
  });

  it("ответ эксперта получает отметку с версией черновика", async () => {
    const chatId = await started();
    await clientAnswered(chatId, 1);
    await (await send(chatId, "Для города подойдёт гибрид. Какой у вас рост?", "expert-answer-1")).text();
    await clientAnswered(chatId, 2);
    expect((await conversationOfChat(database.db, chatId))?.answerMarks["expert-answer-1"]).toEqual({ draftVersionId: lead.draftVersionId });
  });

  it("клиент уходит инструментом: чат закрыт, разговор закончен уходом клиента", async () => {
    const chatId = await started();
    await clientAnswered(chatId, 1);
    clientReply = () => ({ text: "Ладно, спасибо, пойду.", toolCalls: [{ toolName: CLIENT_LEAVE_TOOL, input: { reason: "всё ясно", saidGoodbye: true } }] });
    await (await send(chatId, "Тогда берите гибрид.")).text();
    await vi.waitFor(async () => expect((await chatStorage.getChat(chatId))?.closed).toBeTruthy(), { timeout: 5000 });
    expect(await conversationOfChat(database.db, chatId)).toMatchObject({ status: "finished", finishedReason: "client_left" });
    expect((await send(chatId, "Вы тут?")).status).toBe(409);
  });

  it("чужой чат — 404, заменённый «Начать заново» — 409 stale_role_swap", async () => {
    expect((await send("not-a-role-swap-chat", "Привет")).status).toBe(404);
    const old = await started();
    await clientAnswered(old, 1);
    const result = await endpoint.restart(lead.id, null);
    expect("chatId" in result && result.chatId).not.toBe(old);
    const response = await send(old, "Привет");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { kind: string; message: string } }).error).toMatchObject({ kind: "stale_role_swap" });
  });

  it("без входа эксперта — 401", async () => {
    const chatId = await started();
    signedIn = false;
    expect((await send(chatId, "Привет")).status).toBe(401);
  });

  it("«Начать заново» — новый текущий разговор, прежний заменён и его карточка идёт в прошлые", async () => {
    const first = await started();
    await clientAnswered(first, 1);
    const second = await started();
    expect((await currentConversation(database.db, lead.id))?.chatId).toBe(second);
    expect((await conversationOfChat(database.db, first))?.replacedAt).toBeInstanceOf(Date);
    const cardRequests = calls.filter((call) => !call.toolNames.includes(CLIENT_LEAVE_TOOL));
    expect(JSON.stringify(cardRequests.at(-1)!.options.prompt)).toContain(CARD);
  });

  it("current отдаёт текущий разговор лидмагнита", async () => {
    expect(await endpoint.current(lead.id)).toBeNull();
    const chatId = await started();
    expect(await endpoint.current(lead.id)).toMatchObject({ chatId, status: "active", review: null, finishedReason: null });
  });

  it("смена модели в «Настройках» не меняет модель идущего разговора", async () => {
    const chatId = await started();
    await clientAnswered(chatId, 1);
    choice = { providerId: "stub", modelId: "other-model" };
    const updateModel = vi.spyOn(chatStorage, "updateChatModel");
    await (await send(chatId, "Какой у вас бюджет?")).text();
    await clientAnswered(chatId, 2);
    expect(updateModel).not.toHaveBeenCalled();
    expect((await chatStorage.getChat(chatId))?.modelId).toBe(STUB_MODEL_CHOICE.modelId);
  });

  it("запрос клиента на втором ходе начинается побайтно с запроса первого хода", async () => {
    const chatId = await started();
    await clientAnswered(chatId, 1);
    await (await send(chatId, "Какой у вас бюджет?")).text();
    await clientAnswered(chatId, 2);
    const [first, second] = clientCalls();
    expect(JSON.stringify(second!.options.tools)).toBe(JSON.stringify(first!.options.tools));
    const firstPrompt = first!.options.prompt;
    expect(JSON.stringify(second!.options.prompt.slice(0, firstPrompt.length))).toBe(JSON.stringify(firstPrompt));
  });
});

describe("«Поменяемся ролями»: правка реплики клиента", () => {
  it("правка ложится в журнал: role_swap, client, контекст глазами консультанта, причина", async () => {
    const chatId = await started();
    await clientAnswered(chatId, 1);
    await (await send(chatId, "Гибрид подойдёт. Какой рост?")).text();
    const branch = await clientAnswered(chatId, 2);
    const answer = branch.at(-1)!;

    const corrected = await editAnswer(chatId, answer.id, "175. А гибрид — это как?", { reason: "Новички не знают слов" });

    const [correction] = await correctionsSettled(1);
    expect(correction).toMatchObject({
      source: "role_swap",
      agentRole: "client",
      chatId,
      originalMessageId: answer.id,
      correctedMessageId: corrected,
      answerKind: "reply",
      originalText: "Ну, для города что-нибудь.",
      correctedText: "175. А гибрид — это как?",
      reason: "Новички не знают слов",
      draftVersionId: lead.draftVersionId,
      status: "pending",
    });
    expect(correction!.context.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "assistant", text: FIRST_MESSAGE },
      { role: "user", text: "Ну, для города что-нибудь." },
      { role: "assistant", text: "Гибрид подойдёт. Какой рост?" },
    ]);
  });

  it("клиент продолжает от исправленной реплики", async () => {
    const chatId = await started();
    const [, answer] = await clientAnswered(chatId, 1);
    await editAnswer(chatId, answer!.id, "Хочу на работу ездить.");
    await correctionsSettled(1);
    await (await send(chatId, "Сколько километров?")).text();
    await clientAnswered(chatId, 2);
    expect(JSON.stringify(clientCalls().at(-1)!.options.prompt)).toContain("Хочу на работу ездить.");
  });

  it("метки исправленных реплик; «Убрать правку» возвращает исходную реплику, разобранную убрать нельзя", async () => {
    const chatId = await started();
    const [, answer] = await clientAnswered(chatId, 1);
    const corrected = await editAnswer(chatId, answer!.id, "Хочу на работу ездить.");
    const [correction] = await correctionsSettled(1);

    const listed = await labels(chatId);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ edited: [{ messageId: corrected, correctionId: correction!.id, pending: true }] });

    expect((await removeCorrection(chatId, correction!.id)).status).toBe(204);
    await correctionsSettled(0);
    expect((await loadCurrentBranch(chatStorage, chatId)).at(-1)?.id).toBe(answer!.id);

    const again = await editAnswer(chatId, answer!.id, "Езжу на работу, 10 км.");
    const [next] = await correctionsSettled(1);
    expect(next!.correctedMessageId).toBe(again);
    expect((await resolveCorrections(database.db, lead.id, [next!.id], "rejected")).ok).toBe(true);
    const refused = await removeCorrection(chatId, next!.id);
    expect(refused.status).toBe(409);
  });

  it("метки и «Убрать правку» чужого чата — 404", async () => {
    expect((await labels("not-a-role-swap-chat")).status).toBe(404);
  });
});

const editOwn = (chatId: string, editedMessageId: string, text: string, id = `rs-edit-${++counter}-${Date.now()}`) =>
  endpoint.fetch(
    new Request(`http://localhost/api/role-swap/${chatId}/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ editedMessageId, message: { id, role: "user", parts: [{ type: "text", text }] } }),
    }),
  );

/** Разговор из `answers.length` ответов эксперта, на каждый клиент ответил; итог — ветка. */
async function conversationWith(answers: string[]): Promise<{ chatId: string; ids: string[] }> {
  const chatId = await started();
  await clientAnswered(chatId, 1);
  const ids: string[] = [];
  for (const [index, text] of answers.entries()) {
    const id = `rs-answer-${++counter}-${Date.now()}`;
    ids.push(id);
    await (await send(chatId, text, id)).text();
    await clientAnswered(chatId, index + 2);
  }
  return { chatId, ids };
}

describe("«Поменяемся ролями»: «Закончить и разобрать»", () => {
  it("чат закрыт, разговор отдан; на каждый ответ эксперта — запись с ответом консультанта", async () => {
    const { chatId, ids } = await conversationWith(["Для города — гибрид.", "Какой у вас рост?", "Тогда рама M."]);

    expect(await endpoint.submit(lead.id)).toEqual({ ok: true, recorded: 3, missingComparisons: 0 });

    expect((await chatStorage.getChat(chatId))?.closed).toBeTruthy();
    expect(await endpoint.current(lead.id)).toMatchObject({ chatId, status: "finished", finishedReason: "submitted", review: "ready" });
    const records = await listCorrections(database.db, lead.id, { status: "pending" });
    expect(records.map((record) => [record.source, record.agentRole, record.originalMessageId, record.correctedMessageId, record.correctedText])).toEqual([
      ["role_swap", "consultant", ids[0], ids[0], "Для города — гибрид."],
      ["role_swap", "consultant", ids[1], ids[1], "Какой у вас рост?"],
      ["role_swap", "consultant", ids[2], ids[2], "Тогда рама M."],
    ]);
    expect(records.every((record) => record.originalText === "Консультант ответил бы на «Ну, для города что-нибудь.»")).toBe(true);
    expect(records.every((record) => record.draftVersionId === lead.draftVersionId && record.stageId === lead.draft.flow.start)).toBe(true);
    expect(records[0]!.context.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "assistant", text: FIRST_MESSAGE },
      { role: "user", text: "Ну, для города что-нибудь." },
    ]);
    // Пробный ход видит разговор до ответа глазами консультанта и кончается репликой клиента
    expect(trials.map((input) => input.leadMagnetId)).toEqual([lead.id, lead.id, lead.id]);
    expect(trials.find((input) => input.history.length === 4)!.history.map((line) => line.role)).toEqual(["assistant", "user", "assistant", "user"]);
  });

  it("пробные ходы — не больше трёх одновременно; сбой одного — пустое «было» и счёт недостающих сравнений", async () => {
    await conversationWith(["Один.", "Два.", "Три.", "Четыре."]);
    let running = 0;
    let peak = 0;
    let call = 0;
    trial = async () => {
      const index = ++call;
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return index === 2 ? null : `Ответ ${index}`;
    };

    expect(await endpoint.submit(lead.id)).toEqual({ ok: true, recorded: 4, missingComparisons: 1 });
    expect(peak).toBe(3);
    const records = await listCorrections(database.db, lead.id, { status: "pending" });
    expect(records.filter((record) => record.originalText === "")).toHaveLength(1);
  });

  it("повторное нажатие, пока разбор готовится, — отказ без новых записей", async () => {
    await conversationWith(["Для города — гибрид."]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    trial = async () => {
      await held;
      return "Гибрид.";
    };

    const first = endpoint.submit(lead.id);
    await vi.waitFor(() => expect(trials).toHaveLength(1));
    expect(await endpoint.current(lead.id)).toMatchObject({ review: "preparing" });
    expect(await endpoint.submit(lead.id)).toEqual({ ok: false, error: "preparing" });
    release();
    expect(await first).toEqual({ ok: true, recorded: 1, missingComparisons: 0 });
    expect(trials).toHaveLength(1);
    expect(await endpoint.submit(lead.id)).toEqual({ ok: true, recorded: 0, missingComparisons: 0 });
    expect(await listCorrections(database.db, lead.id, { status: "all" })).toHaveLength(1);
  });

  it("идёт ход клиента — отказ busy, разговор не тронут", async () => {
    const chatId = await started();
    await clientAnswered(chatId, 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    clientReply = () => ({ text: "Думаю…", until: held });
    const response = send(chatId, "Какой бюджет?");
    await vi.waitFor(async () => expect((await loadCurrentBranch(chatStorage, chatId)).at(-1)?.status).toBe("streaming"), { timeout: 5000 });

    expect(await endpoint.submit(lead.id)).toEqual({ ok: false, error: "busy" });
    expect(await endpoint.current(lead.id)).toMatchObject({ status: "active", review: null });
    release();
    await (await response).text();
  });

  it("после ухода клиента разбор работает", async () => {
    const chatId = await started();
    await clientAnswered(chatId, 1);
    clientReply = () => ({ text: "Спасибо, пойду.", toolCalls: [{ toolName: CLIENT_LEAVE_TOOL, input: { reason: "всё ясно", saidGoodbye: true } }] });
    await (await send(chatId, "Берите гибрид.")).text();
    await vi.waitFor(async () => expect((await conversationOfChat(database.db, chatId))?.finishedReason).toBe("client_left"), { timeout: 5000 });

    expect(await endpoint.submit(lead.id)).toEqual({ ok: true, recorded: 1, missingComparisons: 0 });
    expect(await endpoint.current(lead.id)).toMatchObject({ finishedReason: "submitted", review: "ready" });
  });

  it("отданный разговор больше не пишется: ни новой реплики, ни правки своей", async () => {
    const { chatId, ids } = await conversationWith(["Для города — гибрид."]);
    await endpoint.submit(lead.id);
    expect((await send(chatId, "Ещё вопрос?")).status).toBe(409);
    expect((await editOwn(chatId, ids[0]!, "Гибрид или шоссейный.")).status).toBe(409);
    expect(await endpoint.current(lead.id)).toMatchObject({ finishedReason: "submitted" });
  });

  it("отданные ответы эксперта не получают меток «Исправлено» и «Убрать правку»; метки правок клиента на месте", async () => {
    const { chatId } = await conversationWith(["Для города — гибрид."]);
    const [, clientReplyMessage] = (await loadCurrentBranch(chatStorage, chatId)).filter((message) => message.role === "assistant");
    await editAnswer(chatId, clientReplyMessage!.id, "Ну, гибрид так гибрид.");
    await correctionsSettled(1);

    expect(await endpoint.submit(lead.id)).toMatchObject({ ok: true, recorded: 1 });
    const { edited } = (await (await labels(chatId)).json()) as { edited: Array<{ correctionId: string }> };
    const clientEdits = (await listCorrections(database.db, lead.id, { status: "all" })).filter((record) => record.agentRole === "client");
    expect(edited.map((label) => label.correctionId)).toEqual(clientEdits.map((record) => record.id));
  });

  it("разбор, брошенный посреди работы (сервер перезапущен), можно запустить снова", async () => {
    const { chatId } = await conversationWith(["Для города — гибрид."]);
    expect(await setReview(database.db, chatId, "preparing")).toBe(true);
    // Свежий «готовится» — отказ; без признаков жизни дольше срока — брошен
    expect(await endpoint.submit(lead.id)).toEqual({ ok: false, error: "preparing" });
    await database.db
      .update(roleSwapConversations)
      .set({ updatedAt: sql`clock_timestamp() - interval '1 hour'` })
      .where(eq(roleSwapConversations.chatId, chatId));

    expect(await endpoint.current(lead.id)).toMatchObject({ review: "failed" });
    expect(await endpoint.submit(lead.id)).toEqual({ ok: true, recorded: 1, missingComparisons: 0 });
  });

  it("без разговора — отказ", async () => {
    expect(await endpoint.submit(lead.id)).toEqual({ ok: false, error: "no_conversation" });
  });
});

describe("«Поменяемся ролями»: клиент ушёл, эксперт правит свою раннюю реплику", () => {
  it("на новой ветке разговор снова идёт; вернулся на ветку ухода — снова «клиент ушёл»", async () => {
    const chatId = await started();
    await clientAnswered(chatId, 1);
    await (await send(chatId, "Берите гибрид.", "early-answer")).text();
    await clientAnswered(chatId, 2);
    clientReply = () => ({ text: "Спасибо, пойду.", toolCalls: [{ toolName: CLIENT_LEAVE_TOOL, input: { reason: "всё ясно", saidGoodbye: true } }] });
    await (await send(chatId, "Всё, до свидания.")).text();
    await vi.waitFor(async () => expect((await conversationOfChat(database.db, chatId))?.finishedReason).toBe("client_left"), { timeout: 5000 });

    clientReply = () => ({ text: "А почему гибрид?" });
    const edited = await editOwn(chatId, "early-answer", "Для города подойдёт гибрид. Какой рост?");
    expect(edited.status).toBe(200);
    await edited.text();
    await vi.waitFor(async () => expect((await chatStorage.getChat(chatId))?.closed).toBeFalsy(), { timeout: 5000 });
    expect(await endpoint.current(lead.id)).toMatchObject({ status: "active", finishedReason: null });

    const selected = await endpoint.fetch(
      new Request(`http://localhost/api/role-swap/${chatId}/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "early-answer" }),
      }),
    );
    expect(selected.status).toBe(200);
    expect(await endpoint.current(lead.id)).toMatchObject({ status: "finished", finishedReason: "client_left" });
  });
});

describe("«Поменяемся ролями»: строка ноды", () => {
  const stages = [
    { id: "acquaint", name: "Знакомство", instruction: "Узнай задачу.", transitionCondition: "Задача ясна", startDay: null, isSale: false },
    { id: "offer", name: "Предложение", instruction: "Предложи разбор.", transitionCondition: "", startDay: null, isSale: true },
  ];

  beforeEach(async () => {
    const flow = leadMagnetToFlow({ name: lead.draft.name, instruction: "", stages, program: null, fieldIds: [], viewsLinks: false }, []);
    await saveDraft(database.db, lead.id, { ...lead.draft, stages, flow }, "manual");
    lead = (await getLeadMagnet(database.db, lead.id))!;
  });

  const stageName = async () => (await endpoint.current(lead.id))?.stageName;
  const stageBecomes = (name: string) => vi.waitFor(async () => expect(await stageName()).toBe(name), { timeout: 5000 });

  it("после реплики клиента — проверка по переписке, нода у следующего ответа эксперта", async () => {
    judge = async () => ({ stateId: "offer", transitions: [], status: "checked" });
    const chatId = await started();
    await clientAnswered(chatId, 1);
    await stageBecomes("Предложение");
    expect(judged).toHaveLength(1);
    expect(judged[0]).toMatchObject({
      flow: { start: "acquaint" },
      stateId: "acquaint",
      chatId,
      ownerId: (await chatStorage.getChat(chatId))!.ownerId,
      transcript: [
        { role: "agent", text: FIRST_MESSAGE },
        { role: "person", text: "Ну, для города что-нибудь." },
      ],
    });

    // Пробный ход и запись на разбор — с ноды, где эксперт отвечал
    await (await send(chatId, "Предлагаю разбор.", "offer-answer")).text();
    await clientAnswered(chatId, 2);
    await vi.waitFor(() => expect(judged).toHaveLength(2));
    expect(judged[1]!.stateId).toBe("offer");
    expect(await endpoint.submit(lead.id)).toMatchObject({ ok: true, recorded: 1 });
    expect(trials.map((input) => input.stageId)).toEqual(["offer"]);
    expect((await listCorrections(database.db, lead.id, { status: "pending" })).map((record) => record.stageId)).toEqual(["offer"]);
  });

  it("в переписке для проверки — не больше шести последних реплик", async () => {
    const { chatId } = await conversationWith(["Один.", "Два.", "Три."]);
    await vi.waitFor(() => expect(judged).toHaveLength(4));
    expect(judged[3]!.chatId).toBe(chatId);
    expect(judged[3]!.transcript).toHaveLength(6);
    expect(judged[3]!.transcript.at(-1)).toEqual({ role: "person", text: "Ну, для города что-нибудь." });
  });

  it("правка своей реплики — проверка с ноды места правки, а не с ноды брошенной ветки", async () => {
    const next: Record<number, string> = { 1: "offer", 2: "acquaint" };
    judge = async (input) => ({ stateId: next[judged.length] ?? input.stateId, transitions: [], status: "checked" });
    const { chatId, ids } = await conversationWith(["Предлагаю разбор."]);
    await stageBecomes("Знакомство");

    const edited = await editOwn(chatId, ids[0]!, "Давайте разберём ваш случай.");
    expect(edited.status).toBe(200);
    await edited.text();
    await vi.waitFor(() => expect(judged).toHaveLength(3));
    expect(judged[2]!.stateId).toBe("offer");
    expect(judged[2]!.transcript.at(-2)).toEqual({ role: "agent", text: "Давайте разберём ваш случай." });
    await stageBecomes("Предложение");
  });

  it("сбой судьи — нода прежняя, следующая проверка идёт с неё", async () => {
    judge = async () => {
      throw new Error("судья недоступен");
    };
    const { chatId } = await conversationWith(["Предлагаю разбор."]);
    await vi.waitFor(() => expect(judged).toHaveLength(2));
    expect(judged[1]!.stateId).toBe("acquaint");
    expect(await stageName()).toBe("Знакомство");

    judge = async (input) => ({ stateId: input.stateId, transitions: [], status: "unchecked" });
    await (await send(chatId, "Ещё вопрос?")).text();
    await clientAnswered(chatId, 3);
    await vi.waitFor(() => expect(judged).toHaveLength(3));
    expect(await stageName()).toBe("Знакомство");
  });
});
