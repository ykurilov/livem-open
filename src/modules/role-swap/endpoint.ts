import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadCurrentBranch, type AnswerEditedInput, type ChatStorage, type ModelCatalog, type ModelChoice, type StoredMessage } from "@ykurilov/agent-chat-core";
import { judgeExchange, type JudgeExchangeInput, type JudgeExchangeResult } from "@ykurilov/agent-chat-flows";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { createChatServer } from "@ykurilov/agent-chat-server";
import type { ConsultantTrialInput } from "../consultant";
import { createPreviewCorrections } from "../consultant/preview-corrections";
import { recordRoleSwapAnswers } from "../corrections";
import { agentFlowOf, currentRulesOf, leadMagnetJudgeSettings } from "../flows/runtime";
import { getLeadMagnet, type LeadMagnet, type LeadMagnetSettings } from "../lead-magnets";
import { previewOwnerId } from "../platform/cabinet-owner";
import type { Database } from "../platform/db";
import { withDirectModel } from "../platform/direct-model";
import { CLIENT_LEFT_CLOSURE, clientCardBlock, clientInstructions, clientTools, clientTopic } from "./client-agent";
import { ROLE_SWAP_BASE_PATH } from "./base-path";
import { inventClientCard } from "./client-card";
import {
  conversationOfChat,
  currentConversation,
  finishConversation,
  markAnswer,
  markClientStage,
  previousCards,
  reopenConversation,
  reviewOf,
  setReview,
  touchReview,
  startConversation,
  type RoleSwapConversation,
} from "./conversations";
import { roleSwapReviewItems } from "./review-items";
import { judgeTranscript, stageBefore, stageTitle } from "./stages";
import { roleSwapConversations, type RoleSwapAnswerMark, type RoleSwapFinishedReason, type RoleSwapReview, type RoleSwapStatus } from "./schema";

export { ROLE_SWAP_BASE_PATH };

export interface RoleSwapEndpointOptions {
  db: Database;
  chatStorage: ChatStorage;
  catalog: ModelCatalog;
  env?: Record<string, string | undefined>;
  resolveUser: (request: Request) => Promise<{ id: string } | null>;
  /** Модель консультанта по настройкам лидмагнита: на ней играет клиент, она закрепляется в чате при старте. */
  modelChoice: (settings: LeadMagnetSettings) => ModelChoice;
  /** Пробный ход консультанта «Проверки»: что он ответил бы на месте ответа эксперта; сбой — `null`. */
  consultantWouldAnswer: (input: ConsultantTrialInput) => Promise<string | null>;
  /** Проверка перехода по нодам после реплики клиента. Нет — судья сценариев модуля чата на службе этого чата. */
  judgeExchange?: RoleSwapJudge;
}

/** Судья сценария по готовой переписке: куда разговор перешёл из ноды `stateId`. */
export type RoleSwapJudge = (input: JudgeExchangeInput) => Promise<JudgeExchangeResult>;

/** `no_first_message` — у черновика нет первого сообщения: разговору не с чего начаться. */
export type RoleSwapStartResult = { chatId: string } | { error: "no_first_message" };

/**
 * «Закончить и разобрать». `busy` — клиент ещё пишет; `preparing` — разбор уже готовится, повтор ничего не начинает;
 * `failed` — записать ответы не вышло, нажатие можно повторить.
 */
export type RoleSwapSubmitResult =
  | { ok: true; recorded: number; missingComparisons: number }
  | { ok: false; error: "no_conversation" | "busy" | "preparing" | "failed" };

/** Пробные ходы консультанта идут не больше чем по три сразу, каждый — не дольше минуты. */
export const TRIAL_CONCURRENCY = 3;
const TRIAL_TURN_MS = 60_000;
/** Отданный разговор закрыт: эксперт видит этот текст вместо поля ввода. */
export const SUBMITTED_CLOSURE = { code: "submitted", message: "Разговор отдан на разбор" } as const;

export interface RoleSwapState {
  chatId: string;
  status: RoleSwapStatus;
  review: RoleSwapReview | null;
  finishedReason: RoleSwapFinishedReason | null;
  /** Нода сценария черновика, где сейчас разговор, — название для строки над лентой. */
  stageName: string | null;
}

export interface RoleSwapEndpoint {
  /** Адрес чата `/api/role-swap`: чат модуля чата, где агент — клиент, плюс метки правок и «Убрать правку». */
  fetch(request: Request): Promise<Response>;
  /** Новый разговор: карточка клиента, чат, первое сообщение лидмагнита от имени эксперта; клиент отвечает обычным ходом. */
  start(leadMagnetId: string, brief: string | null): Promise<RoleSwapStartResult>;
  /** «Начать заново»: то же, что старт; прежний разговор заменяется. */
  restart(leadMagnetId: string, brief: string | null): Promise<RoleSwapStartResult>;
  current(leadMagnetId: string): Promise<RoleSwapState | null>;
  /**
   * «Закончить и разобрать»: чат закрывается, на каждый ответ эксперта текущей ветки считается ответ консультанта, и
   * ответы встают в очередь «Разобрать правки». Уже отданный и разобранный разговор второй раз ничего не записывает.
   */
  submit(leadMagnetId: string): Promise<RoleSwapSubmitResult>;
}

const notFound = () => Response.json({ error: { kind: "not_found" } }, { status: 404 });

/** Разговор «Поменяемся ролями»: эксперт отвечает за консультанта, агент играет клиента лидмагнита. */
export function createRoleSwapEndpoint(options: RoleSwapEndpointOptions): RoleSwapEndpoint {
  const { db, chatStorage } = options;
  const ownerOf = async (chatId: string) => (await chatStorage.getChat(chatId))?.ownerId ?? previewOwnerId(chatId);
  // Запрос к чату — от владельца этого чата; без чата (меню моделей) — от кабинета
  const resolveUser = async (request: Request) => {
    const user = await options.resolveUser(request);
    if (!user) return null;
    const [chatId] = new URL(request.url).pathname.slice(ROLE_SWAP_BASE_PATH.length + 1).split("/");
    return chatId && chatId !== "models" && chatId !== "attachments" ? { id: await ownerOf(decodeURIComponent(chatId)) } : user;
  };

  async function leadOfChat(chatId: string) {
    const conversation = await conversationOfChat(db, chatId);
    const lead = conversation && (await getLeadMagnet(db, conversation.leadMagnetId));
    if (!lead) throw new Error(`Чат ${chatId} — не разговор «Поменяемся ролями»`);
    return lead;
  }

  const server = createChatServer({
    basePath: ROLE_SWAP_BASE_PATH,
    storage: chatStorage,
    catalog: options.catalog,
    ...(options.env && { env: options.env }),
    resolveUser,
    // Модель закреплена в чате при старте: меню моделей нет, смена модели в «Настройках» кэш клиента не ломает
    // Отданный на разбор разговор закрыт навсегда: правка или выбор ветки до закрытия не открывают его снова
    chatCapabilities: async ({ chat }) =>
      (await conversationOfChat(db, chat.id))?.finishedReason === "submitted"
        ? { steer: false, answerEditing: false, modelChoice: false, attachments: false, regenerate: false, edit: false, retry: false, branches: false }
        : { steer: false, answerEditing: true, modelChoice: false, attachments: false, regenerate: true },
    // «Поправить» реплику клиента: правка ложится в журнал правок для конструктора
    answerEditing: true,
    onAnswerEdited: (input: AnswerEditedInput) => corrections.onAnswerEdited(input),
    // Реплика эксперта помнит версию черновика, на которой прозвучала
    beforeTurn: async ({ chat, action, messageId }) => {
      // Правка своей реплики до ухода клиента начинает ветку, где клиент ещё здесь
      if (action === "edit" || action === "regenerate") await reopenConversation(db, chat.id);
      if ((action !== "send" && action !== "edit") || !messageId) return;
      const conversation = await conversationOfChat(db, chat.id);
      const lead = conversation && (await getLeadMagnet(db, conversation.leadMagnetId));
      if (lead) await markAnswer(db, chat.id, messageId, { draftVersionId: lead.draftVersionId });
    },
    // Клиент ответил — куда по нодам сценария перешёл разговор. Пока идёт проверка, чат занят: эксперт отвечает уже из
    // новой ноды
    afterTurn: async ({ chatId, messageId, status }) => {
      if (status === "complete") await checkTransition(chatId, messageId);
    },
    agent: {
      instructions: clientInstructions(),
      // Одна реплика на ход: после ухода модель не зовут снова, иначе она допишет «итог разговора»
      maxSteps: 1,
      tools: clientTools((chatId) => finishConversation(db, chatId, "client_left")),
      contextBlocks: async ({ chatId }) => {
        const conversation = await conversationOfChat(db, chatId);
        return conversation ? [clientCardBlock(conversation)] : [];
      },
    },
  });

  const judge: RoleSwapJudge =
    options.judgeExchange ??
    ((input) =>
      judgeExchange(input, {
        judge: leadMagnetJudgeSettings(options.env ?? process.env),
        port: () => server.service,
        ...(options.env && { env: options.env }),
        logError: (line) => console.error(line),
      }));

  /** Сценарий черновика как объект; без начальной ноды строки ноды нет. */
  const draftFlowOf = (lead: LeadMagnet) => {
    const flow = agentFlowOf(currentRulesOf(lead.draft.flow));
    return flow?.start ? flow : null;
  };

  /** Проверка перехода после реплики клиента: с ноды, где эксперт отвечал. Сбой судьи — нода прежняя. */
  async function checkTransition(chatId: string, messageId: string): Promise<void> {
    try {
      const conversation = await conversationOfChat(db, chatId);
      const lead = conversation && (await getLeadMagnet(db, conversation.leadMagnetId));
      const flow = lead && draftFlowOf(lead);
      if (!conversation || !flow) return;
      const branch = await loadCurrentBranch(chatStorage, chatId);
      const index = branch.findIndex((message) => message.id === messageId);
      if (branch[index]?.role !== "assistant") return;
      const from = stageBefore(branch, conversation.clientStages, index, flow)!;
      const stageId = await judge({ flow, stateId: from, transcript: judgeTranscript(branch, index), ownerId: await ownerOf(chatId), chatId })
        .then((result) => result.stateId)
        .catch((error: unknown) => {
          console.error(`Проверка перехода в ${chatId} не удалась:`, error instanceof Error ? error.message : error);
          return from;
        });
      await markClientStage(db, chatId, messageId, stageId);
    } catch (error) {
      console.error(`Нода после реплики клиента в ${chatId} не записана:`, error instanceof Error ? error.message : error);
    }
  }

  /** Где сейчас разговор: нода после последней проверенной реплики клиента текущей ветки. */
  async function currentStageName(conversation: RoleSwapConversation): Promise<string | null> {
    const lead = await getLeadMagnet(db, conversation.leadMagnetId);
    const flow = lead && draftFlowOf(lead);
    if (!flow) return null;
    const branch = await loadCurrentBranch(chatStorage, conversation.chatId);
    return stageTitle(flow, stageBefore(branch, conversation.clientStages, branch.length, flow));
  }

  const corrections = createPreviewCorrections({
    db,
    chatStorage,
    leadOfChat,
    readRun: async () => null,
    serviceOfChat: async () => server.service,
    kind: { source: "role_swap", agentRole: "client" },
  });

  /** Метки исправленных реплик клиента и «Убрать правку» — как в «Проверке». */
  async function handleCorrections(request: Request, chatId: string, segments: string[]): Promise<Response> {
    const lead = await leadOfChat(chatId);
    const method = request.method.toUpperCase();
    if (method === "GET" && segments.length === 2) return Response.json({ edited: await corrections.editedAnswers(lead, chatId) });
    if (method === "DELETE" && segments.length === 3) {
      const result = await corrections.remove(lead, chatId, decodeURIComponent(segments[2]!));
      if (result === "removed") return new Response(null, { status: 204 });
      if (result === "not_found") return notFound();
      const message = result === "resolved" ? "Эту правку конструктор уже разобрал, убрать её нельзя." : "Дождитесь ответа клиента и попробуйте ещё раз.";
      return Response.json({ error: { kind: result, message } }, { status: 409 });
    }
    return notFound();
  }

  async function start(leadMagnetId: string, brief: string | null): Promise<RoleSwapStartResult> {
    const lead = await getLeadMagnet(db, leadMagnetId);
    if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
    const firstMessage = lead.draft.firstMessage.trim();
    if (!firstMessage) return { error: "no_first_message" };
    const chatId = randomUUID();
    const choice = options.modelChoice(lead.draft);
    const clientBrief = brief?.trim() || null;
    const earlier = await previousCards(db, leadMagnetId);
    const deps = { catalog: options.catalog, ...(options.env && { env: options.env }) };
    const clientCard = await withDirectModel(deps, choice, chatId, (direct) =>
      inventClientCard({ direct, lead: lead.draft, brief: clientBrief, previousCards: earlier }),
    );
    const ownerId = previewOwnerId(chatId);
    await chatStorage.createChat({ id: chatId, ownerId, ...choice });
    let stream: Awaited<ReturnType<typeof server.service.sendMessage>>;
    try {
      await startConversation(db, { chatId, leadMagnetId, clientBrief, clientCard, topic: clientTopic(lead.draft) });
      // Живой клиент тоже первым получает это сообщение; ответ клиента идёт обычным ходом, экран подхватит его из ленты
      stream = await server.service.sendMessage(ownerId, chatId, { id: randomUUID(), role: "user", parts: [{ type: "text", text: firstMessage }] });
    } catch (error) {
      // Разговор, где клиент так и не получил первое сообщение, не остаётся текущим: эксперт снова видит экран старта
      await db.delete(roleSwapConversations).where(eq(roleSwapConversations.chatId, chatId)).catch(() => {});
      await chatStorage.deleteChat(chatId).catch(() => {});
      throw error;
    }
    void stream.pipeTo(new WritableStream()).catch((error: unknown) => {
      console.error(`Первый ход клиента в ${chatId} не удался:`, error instanceof Error ? error.message : error);
    });
    return { chatId };
  }

  /**
   * Закрытие у модуля чата — у каждой ветки своё: эксперт мог уйти правкой с ветки, где клиент ушёл, или вернуться на
   * неё. Состояние разговора считается по текущей ветке, без записи: чтение страницы базу не меняет. Отданный на разбор
   * не меняется.
   */
  async function followBranch(conversation: RoleSwapConversation): Promise<RoleSwapConversation> {
    if (conversation.finishedReason === "submitted") return conversation;
    const left = (await chatStorage.getChat(conversation.chatId))?.closed?.code === CLIENT_LEFT_CLOSURE.code;
    return left ? { ...conversation, status: "finished", finishedReason: "client_left" } : { ...conversation, status: "active", finishedReason: null };
  }

  async function submit(leadMagnetId: string): Promise<RoleSwapSubmitResult> {
    const conversation = await currentConversation(db, leadMagnetId);
    if (!conversation) return { ok: false, error: "no_conversation" };
    const { chatId } = conversation;
    if (reviewOf(conversation) === "preparing") return { ok: false, error: "preparing" };
    if (conversation.review === "ready") return { ok: true, recorded: 0, missingComparisons: 0 };
    const ownerId = await ownerOf(chatId);
    const history = await server.service.peekHistory(ownerId, chatId);
    if (history.running || history.detachedAnswer) return { ok: false, error: "busy" };
    if (!(await setReview(db, chatId, "preparing"))) return { ok: false, error: "preparing" };
    try {
      if (!history.chat.closed || history.chat.closed.code !== SUBMITTED_CLOSURE.code) await server.service.closeChat({ ownerId, chatId, ...SUBMITTED_CLOSURE });
      await finishConversation(db, chatId, "submitted");
      const lead = await getLeadMagnet(db, leadMagnetId);
      if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
      const branch = await loadCurrentBranch(chatStorage, chatId);
      const items = roleSwapReviewItems(branch, withStages(branch, conversation, draftFlowOf(lead)), lead.draftVersionId);
      const comparisons = await mapLimited(items, TRIAL_CONCURRENCY, async (item) => {
        if (item.history.at(-1)?.role !== "user") return null;
        const text = await options
          .consultantWouldAnswer({ leadMagnetId, history: item.history, ...(item.stageId && { stageId: item.stageId }), timeoutMs: TRIAL_TURN_MS })
          .catch(() => null);
        await touchReview(db, chatId);
        return text;
      });
      const recorded = await recordRoleSwapAnswers(db, {
        leadMagnetId,
        chatId,
        answers: items.map(({ messageId, expertText, context, stageId, draftVersionId }, index) => ({
          messageId,
          expertText,
          consultantText: comparisons[index] ?? null,
          context,
          stageId,
          draftVersionId,
        })),
      });
      await setReview(db, chatId, "ready");
      return { ok: true, recorded, missingComparisons: comparisons.filter((text) => text === null).length };
    } catch (error) {
      console.error(`«Закончить и разобрать» в ${chatId} не удалось:`, error instanceof Error ? error.message : error);
      await setReview(db, chatId, "failed").catch(() => {});
      return { ok: false, error: "failed" };
    }
  }

  return {
    async fetch(request) {
      // Вход — первым: без него ни записей, ни ответов о состоянии разговора
      if (!(await options.resolveUser(request))) return Response.json({ error: "unauthenticated" }, { status: 401 });
      const segments = new URL(request.url).pathname.slice(ROLE_SWAP_BASE_PATH.length + 1).split("/");
      const chatId = segments[0] ? decodeURIComponent(segments[0]) : "";
      // Без чата — только меню моделей и настройки вложений: свой чат здесь заводит только старт
      if (chatId === "models" || chatId === "attachments") return server.handler.fetch(request);
      if (!chatId) return notFound();
      const conversation = await conversationOfChat(db, chatId);
      if (!conversation) return notFound();
      if (conversation.replacedAt)
        return Response.json({ error: { kind: "stale_role_swap", message: "Этот разговор уже начат заново. Обновите страницу." } }, { status: 409 });
      // Отданный на разбор разговор только читается
      if (conversation.finishedReason === "submitted" && request.method.toUpperCase() !== "GET")
        return Response.json(
          { error: { kind: "role_swap_submitted", message: "Разговор уже отдан на разбор. Чтобы поговорить ещё, начните заново." } },
          { status: 409 },
        );
      if (segments[1] === "corrections") return handleCorrections(request, chatId, segments);
      return server.handler.fetch(request);
    },

    start,
    restart: start,

    async current(leadMagnetId) {
      const stored = await currentConversation(db, leadMagnetId);
      if (!stored) return null;
      const conversation = await followBranch(stored);
      const { chatId, status, finishedReason } = conversation;
      return { chatId, status, review: reviewOf(conversation), finishedReason, stageName: await currentStageName(conversation) };
    },

    submit,
  };
}

/** Отметки ответов эксперта с нодой, где прозвучал каждый ответ: она — по проверкам после реплик клиента выше по ветке. */
function withStages(branch: readonly StoredMessage[], conversation: RoleSwapConversation, flow: AgentFlow | null): Record<string, RoleSwapAnswerMark> {
  if (!flow) return conversation.answerMarks;
  const marks = { ...conversation.answerMarks };
  for (const [index, message] of branch.entries()) {
    const mark = marks[message.id];
    const stageId = message.role === "user" && mark && stageBefore(branch, conversation.clientStages, index, flow);
    if (stageId) marks[message.id] = { ...mark, stageId };
  }
  return marks;
}

/** `run` по каждому элементу, не больше `limit` одновременно; итог — в порядке элементов. */
async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
