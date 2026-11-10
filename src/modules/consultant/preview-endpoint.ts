import { randomUUID } from "node:crypto";
import { loadCurrentBranch, type AnswerEditedInput, type ChatStorage, type ModelCatalog, type ModelChoice } from "@ykurilov/agent-chat-core";
import { flowTestChatData } from "@ykurilov/agent-chat-flows";
import { createChatHandler, createChatServer, type ChatHandler } from "@ykurilov/agent-chat-server";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createFlowLog } from "../flows/flow-log";
import { moveTestChatToDraft } from "../flows/chat-migration";
import { cacheMissLog } from "./cache-miss-log";
import { agentFlowOf, createLeadMagnetFlow, loadLeadMagnetFlow, type LeadMagnetFlow } from "../flows/runtime";
import { findLeadMagnetByPreviewChat, getLeadMagnet, setPreviewChat, type LeadMagnetSettings } from "../lead-magnets";
import { CABINET_OWNER_ID, previewOwnerId } from "../platform/cabinet-owner";
import { systemClock, type Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import { turnChatId } from "../platform/turn-request";
import { createTurnTails } from "../platform/turn-tails";
import { previewFarewellStorage } from "./preview-farewell";
import { createFlowTestRoutes, type FlowTestClockResult } from "./preview-flow-test";
import { createPreviewCorrections } from "./preview-corrections";
import { createPreviewConversationStore, readPreviewConversation, reopenPreviewConversation, startPreviewConversation } from "./preview-store";
import { previewConversations } from "./schema";
import { consultantStepContext } from "./step-context";
import { leadMagnetImageSource } from "../images";
import { leadMagnetVideoSource } from "../videos";
import { consultantAgentSettings, liveConsultantVersion, VersionCache, type LiveConsultantVersion } from "./services";
import { consultantReplyChecks } from "./reply-checks";
import { lastReplyParts, singleReplyStorage } from "./single-reply";
import type { Attachments } from "@ykurilov/agent-chat-attachments";
import { suggestClientReply } from "./autoreply";
import { withDirectModel } from "../platform/direct-model";
import { buildConsultantTail } from "./tail";
import { personLinkFromEnv } from "./person-link";

export const PREVIEW_BASE_PATH = "/api/preview";

export interface PreviewEndpointOptions {
  db: Database;
  /** Пул той же базы: хранилище сценариев SDK. */
  pool: Pool;
  /** Часы сценария; по умолчанию системные. */
  clock?: Clock;
  /** Запасной судья сценария; не задан — DeepSeek 4.1 Flash. */
  judgeFallback?: ModelChoice;
  chatStorage: ChatStorage;
  catalog: ModelCatalog;
  env?: Record<string, string | undefined>;
  resolveUser: (request: Request) => Promise<{ id: string } | null>;
  /** Модель консультанта по настройкам лидмагнита. */
  modelChoice: (settings: LeadMagnetSettings) => ModelChoice;
  /** Картинки клиента: принимаются, только если лидмагнит их разрешил (`clientImages`). */
  attachments?: Attachments;
}

export interface PreviewStatus {
  chatId: string;
  stageName: string | null;
  /** День тестового разговора и срок программы; у лидмагнита без программы — `null`. */
  day: number | null;
  days: number | null;
  finished: boolean;
}

export interface PreviewEndpoint {
  fetch(request: Request): Promise<Response>;
  /** Текущий тестовый разговор; нет — начинает новый. */
  ensurePreview(leadMagnetId: string): Promise<string>;
  /** «Автоответ»: реплика клиента на последнее сообщение консультанта — экран сразу её отправляет. */
  suggestReply(chatId: string): Promise<string>;
  /** «Начать заново»: новый разговор с первым сообщением лидмагнита. */
  restartPreview(leadMagnetId: string): Promise<string>;
  status(leadMagnetId: string): Promise<PreviewStatus | null>;
  /**
   * «Продолжить разговор»: завершённый тестовый разговор снова принимает сообщения. Консультант продолжает с того места,
   * где закончил; брошенный («не завершил») сценарий открывается заново. Незавершённый — ничего не меняется.
   * Сценарий не открывается (вышел срок программы) — `PreviewReopenRefused`, разговор остаётся завершённым.
   */
  reopenPreview(leadMagnetId: string): Promise<void>;
  /**
   * «К началу следующего дня»: часы тестового разговора сценария — к началу следующего дня; нода по сроку меняется сама,
   * консультант пишет утреннее сообщение по обычным правилам сценария. `timeZone` — пояс браузера эксперта: по нему
   * дни, если чат ещё не за сценарием (эксперт не писал).
   */
  nextDay(leadMagnetId: string, timeZone?: string): Promise<void>;
  /** Часы тестового разговора вперёд на `ms` (от минуты до тридцати суток); возвращает сдвиг часов, мс. */
  advanceBy(leadMagnetId: string, ms: number, timeZone?: string): Promise<number>;
  /** Часы тестового разговора к ближайшему сообщению сценария первым; впереди ничего — отказ с `code: "nothing_scheduled"`. */
  advanceToNextFirstMessage(leadMagnetId: string, timeZone?: string): Promise<FlowTestClockResult>;
  /**
   * Пробный ход консультанта: что он ответил бы на последнюю реплику `history` (ориентация консультанта, кончается
   * репликой клиента) по текущему черновику, с ноды `stageId` (нет или не найдена — стартовая нода). Ход идёт в
   * одноразовом тестовом чате, после него чат и его запись удаляются. Сбой модели или срок `timeoutMs` — `null`.
   */
  consultantWouldAnswer(input: ConsultantTrialInput): Promise<string | null>;
  /** Сценарий тестовых разговоров: место чата для доски (`readRun`). */
  flow: LeadMagnetFlow;
}

export interface ConsultantTrialInput {
  leadMagnetId: string;
  history: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  stageId?: string;
  /** Срок хода, мс; по умолчанию минута. */
  timeoutMs?: number;
}

/** «Продолжить разговор» не вышло: сценарий не открывается. В `message` — что делать эксперту. */
export class PreviewReopenRefused extends Error {}

type FlowReopenRefusal = Extract<Awaited<ReturnType<LeadMagnetFlow["reopen"]>>, { reopened: false }>["reason"];

function reopenRefusalText(reason: FlowReopenRefusal): string {
  const why =
    reason === "deadline" || reason === "deadline_passed"
      ? "Срок программы в этом тестовом разговоре уже вышел, продолжить его нельзя."
      : "Этот тестовый разговор продолжить нельзя.";
  return `${why} Нажмите «Начать проверку заново», чтобы пройти его с начала.`;
}

const SERVICES_IN_MEMORY = 20;
/** Конец сценария прежнего тестового чата после «Начать проверку заново». */
const PREVIEW_RESTARTED_REASON = "preview_restarted";
/** Конец сценария одноразового чата пробного хода. */
const TRIAL_TURN_REASON = "consultant_trial";
const TRIAL_TURN_MS = 60_000;

/** Тестовый разговор эксперта с консультантом на текущей версии черновика. Без дневного лимита и без записи в базу людей. */
export function createPreviewEndpoint(options: PreviewEndpointOptions): PreviewEndpoint {
  const { db, chatStorage } = options;
  const store = createPreviewConversationStore(db);
  const personLink = personLinkFromEnv(options.env ?? process.env, chatStorage);
  const tails = createTurnTails();
  /** Владелец тестового чата: свой у каждого (`previewOwnerId`), у начатых раньше — общий владелец кабинета. */
  const ownerOf = async (chatId: string) => (await chatStorage.getChat(chatId))?.ownerId ?? previewOwnerId(chatId);
  // Запрос к чату идёт от владельца этого чата; без чата (меню моделей) — от кабинета
  const resolveUser = async (request: Request) => {
    if (!(await options.resolveUser(request))) return null;
    const [chatId] = new URL(request.url).pathname.slice(PREVIEW_BASE_PATH.length + 1).split("/");
    return { id: chatId && chatId !== "models" ? await ownerOf(decodeURIComponent(chatId)) : CABINET_OWNER_ID };
  };
  // Сценарий «Проверки»: ответы, написанные первым, остаются в чате эксперта — своей доставки не нужно
  const clock = options.clock ?? systemClock;
  const flow = createLeadMagnetFlow({
    db,
    pool: options.pool,
    clock,
    ...(options.env && { env: options.env }),
    ...(options.judgeFallback && { judgeFallback: options.judgeFallback }),
    writesFirstToChat: true,
  });
  const flowLog = createFlowLog(db, (chatId) => loadLeadMagnetFlow(db, chatId));
  const stepContext = consultantStepContext({
    tails,
    store,
    readRun: (ownerId, chatId) => flow.readRun(ownerId, chatId),
    onFirstReasons: (reasons) => flowLog.firstMessage(reasons),
  });
  const dayOf = async ({ ownerId, chatId }: { ownerId: string; chatId: string }) => (await flow.readRun(ownerId, chatId))?.day?.day ?? 1;
  // Промах кэша — с днём программы и нодой чата: так промахи раскладываются по дням и нодам
  const logError = cacheMissLog({ ownerOf, readRun: (ownerId, chatId) => flow.readRun(ownerId, chatId), log: (line) => console.error(line) });

  type PreviewServer = ReturnType<typeof createChatServer>;
  const servers = new VersionCache<PreviewServer>(SERVICES_IN_MEMORY);
  const serverFor = ({ key, settings, knowledge }: LiveConsultantVersion): Promise<PreviewServer> =>
    servers.get(key, async () =>
      createChatServer(
        flow.withChat({
          basePath: PREVIEW_BASE_PATH,
          // Ответ — один на ход, с прощанием приложения в конце; чужие слова и ссылки проверяет служба SDK до записи,
          // поэтому прощание эксперта проверка не видит
          storage: previewFarewellStorage(singleReplyStorage(chatStorage), {
            farewellMessage: settings.farewellMessage,
            summaryOf: async (chatId) => (await readPreviewConversation(db, chatId))?.summary ?? null,
            // Ответ из finish_dialog — теми же проверками, что ответ модели, службой этого же разговора
            checkedAnswer: async ({ chatId, messageId, answer }): Promise<string> =>
              (await (await serverOfChat(chatId)).service.checkReply({ ownerId: await ownerOf(chatId), chatId, text: answer, messageId })).text,
          }),
          // Как в мессенджере: эксперт видит только проверенный текст, фраза перед инструментом не мелькает исходной
          replyChecks: { ...consultantReplyChecks({ db, settings, knowledge }), web: "hold" },
          logError: (line: string) => void logError(line),
          catalog: options.catalog,
          defaultChoice: options.modelChoice(settings),
          ...(options.env && { env: options.env }),
          resolveUser,
          // «Проверка» изображает мессенджер: там поправки на лету нет, и ответ на ход один. Пометки «Агент написал первым —
          // человек молчал…» видит только эксперт в тестовом разговоре: боевые чаты и конструктор их не получают
          // Картинки клиента — как в мессенджере: только если лидмагнит их принимает, иначе и запрос, и поле ввода прежние
          ...(options.attachments && settings.clientImages && { attachments: options.attachments }),
          chatCapabilities: () => ({ steer: false, appNotices: true, attachments: settings.clientImages, answerEditing: true }),
          // «Поправить»: эксперт правит ответ консультанта, правка ложится в журнал правок для конструктора
          answerEditing: true,
          onAnswerEdited: (input: AnswerEditedInput) => corrections.onAnswerEdited(input),
          agent: {
            ...consultantAgentSettings({
              settings,
              store,
              videos: leadMagnetVideoSource(db, settings.videoIds),
              images: leadMagnetImageSource(db, settings.imageIds),
              personLink,
              stepContext,
              dayOf,
              knowledge,
            }),
            // Инструкции правят на ходу: модель видит только текущую карточку шага, прошлые ответы — без старых правил
            contextBlocksHistory: { latest: ["flow:state"] },
          },
        }),
      ),
    );
  /** Служба тестового разговора по его чату: черновик лидмагнита, у которого этот чат открыт в «Проверке». */
  async function leadOfChat(chatId: string) {
    const lead = await findLeadMagnetByPreviewChat(db, chatId);
    const preview = lead ? null : await readPreviewConversation(db, chatId);
    const owner = lead ?? (preview && (await getLeadMagnet(db, preview.leadMagnetId)));
    if (!owner) throw new Error(`Чат ${chatId} — не тестовый разговор`);
    return owner;
  }
  async function serverOfChat(chatId: string): Promise<PreviewServer> {
    const owner = await leadOfChat(chatId);
    return serverFor(await liveConsultantVersion(db, owner.draftVersionId, owner.draft));
  }
  flow.attachPorts(async ({ chatId }) => (await serverOfChat(chatId)).service);
  const corrections = createPreviewCorrections({
    db,
    chatStorage,
    leadOfChat,
    readRun: (ownerId, chatId) => flow.readRun(ownerId, chatId),
    serviceOfChat: async (chatId) => (await serverOfChat(chatId)).service,
  });

  /** Метки исправленных ответов и «Убрать правку»: `GET …/:chatId/corrections`, `DELETE …/:chatId/corrections/:id`. */
  async function handleCorrections(request: Request, segments: string[]): Promise<Response> {
    const chatId = decodeURIComponent(segments[0]!);
    const lead = await findLeadMagnetByPreviewChat(db, chatId);
    if (!lead) return Response.json({ error: { kind: "not_found" } }, { status: 404 });
    const method = request.method.toUpperCase();
    if (method === "GET" && segments.length === 2) return Response.json({ edited: await corrections.editedAnswers(lead, chatId) });
    if (method === "DELETE" && segments.length === 3) {
      const result = await corrections.remove(lead, chatId, decodeURIComponent(segments[2]!));
      if (result === "removed") return new Response(null, { status: 204 });
      if (result === "not_found") return Response.json({ error: { kind: "not_found" } }, { status: 404 });
      const message = result === "resolved" ? "Эту правку конструктор уже разобрал, убрать её нельзя." : "Дождитесь ответа консультанта и попробуйте ещё раз.";
      return Response.json({ error: { kind: result, message } }, { status: 409 });
    }
    return Response.json({ error: { kind: "not_found" } }, { status: 404 });
  }

  let plainHandler: ChatHandler | undefined;
  const plain = () =>
    (plainHandler ??= createChatHandler({
      basePath: PREVIEW_BASE_PATH,
      storage: chatStorage,
      catalog: options.catalog,
      ...(options.env && { env: options.env }),
      ...(options.attachments && { attachments: options.attachments }),
      resolveUser,
      agent: { instructions: "" },
    }));

  /**
   * Тестовый чат — за сценарием черновика без хода: «К началу следующего дня» до первого сообщения эксперта. Пояс — из
   * браузера эксперта: от него день 1 и утро. Закрепить при создании чата нельзя — пояс тогда ещё неизвестен, а SDK
   * считает начало дня 1 по поясу на момент закрепления.
   */
  async function pinToFlow(chatId: string, timeZone?: string): Promise<void> {
    const loaded = await loadLeadMagnetFlow(db, chatId);
    if (!loaded) return;
    const now = clock.now();
    try {
      await flow.adopt({ ownerId: await ownerOf(chatId), chatId, ...loaded, startedAt: now, lastAgentAt: now, ...(timeZone && { timeZone }) });
    } catch (error) {
      // Сценарий черновика с ошибкой: проверка идёт без сценария, первый ход попробует закрепить чат снова
      console.error(`Тестовый чат ${chatId} не закреплён за сценарием:`, error instanceof Error ? error.message : error);
    }
  }

  async function startChat(leadMagnetId: string): Promise<string> {
    const lead = await getLeadMagnet(db, leadMagnetId);
    if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
    const chatId = randomUUID();
    const choice = options.modelChoice(lead.draft);
    // Тестовый чат сценария: его часы можно промотать к следующему дню
    await chatStorage.createChat({ id: chatId, ownerId: previewOwnerId(chatId), ...choice, data: flowTestChatData() });
    const firstMessage = lead.draft.firstMessage.trim();
    if (firstMessage) {
      await chatStorage.insertMessage({
        id: randomUUID(),
        chatId,
        parentId: null,
        role: "assistant",
        parts: [{ type: "text", text: firstMessage }],
        formatVersion: 1,
        status: "complete",
        modelId: null,
        providerId: null,
        usage: null,
        reasoningDurationsMs: {},
        error: null,
        createdAt: new Date().toISOString(),
      });
    }
    await startPreviewConversation(db, { chatId, leadMagnetId });
    // Прежний чат больше не открыть: его сценарий кончается, чтобы сроки, касания и судья не шли впустую
    const previous = lead.previewChatId;
    if (previous) await flow.end({ ownerId: await ownerOf(previous), chatId: previous, reason: PREVIEW_RESTARTED_REASON });
    await setPreviewChat(db, leadMagnetId, chatId);
    return chatId;
  }

  async function reopen(chatId: string): Promise<void> {
    // Сценарий снова идёт: консультант продолжает в той ноде, где разговор кончился
    // Тестовый чат эксперта открывается и после итоговой ноды; срок программы и блокировку SDK не снимает
    const result = await flow.reopen({ ownerId: await ownerOf(chatId), chatId, allowFinal: true, reason: "expert preview" });
    // Чат не за сценарием или сценарий и не кончался — конец был только у приложения, его и снимаем
    if (!result.reopened && result.reason !== "not_flow" && result.reason !== "not_ended") throw new PreviewReopenRefused(reopenRefusalText(result.reason));
    await reopenPreviewConversation(db, chatId);
  }

  async function consultantWouldAnswer({ leadMagnetId, history, stageId, timeoutMs = TRIAL_TURN_MS }: ConsultantTrialInput): Promise<string | null> {
    const question = history.at(-1);
    if (question?.role !== "user") throw new Error("Пробный ход: история должна кончаться репликой клиента");
    const lead = await getLeadMagnet(db, leadMagnetId);
    if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
    const chatId = randomUUID();
    const ownerId = previewOwnerId(chatId);
    try {
      await chatStorage.createChat({ id: chatId, ownerId, ...options.modelChoice(lead.draft) });
      let parentId: string | null = null;
      for (const line of history.slice(0, -1)) {
        const id = randomUUID();
        await chatStorage.insertMessage({
          id,
          chatId,
          parentId,
          role: line.role,
          parts: [{ type: "text", text: line.text }],
          formatVersion: 1,
          status: "complete",
          modelId: null,
          providerId: null,
          usage: null,
          reasoningDurationsMs: {},
          error: null,
          createdAt: new Date().toISOString(),
        });
        parentId = id;
      }
      // Чат «Проверки» без привязки к лидмагниту: служба версии находит черновик по записи разговора
      await startPreviewConversation(db, { chatId, leadMagnetId });
      const loaded = await loadLeadMagnetFlow(db, chatId);
      if (loaded) {
        const stateId = stageId && lead.draft.flow.states.some((state) => state.id === stageId) ? stageId : undefined;
        const now = clock.now();
        // Сценарий черновика с ошибкой: ход идёт без закрепления, как в «Проверке»
        await flow
          .adopt({ ownerId, chatId, ...loaded, ...(stateId && { stateId }), startedAt: now, lastAgentAt: now })
          .catch((error: unknown) => console.error(`Пробный чат ${chatId} не закреплён за сценарием:`, error instanceof Error ? error.message : error));
      }
      const { service } = await serverFor(await liveConsultantVersion(db, lead.draftVersionId, lead.draft));
      const personMessageCount = history.filter((line) => line.role === "user").length;
      tails.set(chatId, buildConsultantTail({ settings: lead.draft, personMessageCount }));
      const stream = await service.sendMessage(ownerId, chatId, { id: randomUUID(), role: "user", parts: [{ type: "text", text: question.text }] });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = await Promise.race([
        drainStream(stream).then(() => true),
        new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
      ]).finally(() => clearTimeout(timer));
      if (!done) {
        await service.stop(ownerId, chatId);
        return null;
      }
      const answer = (await loadCurrentBranch(chatStorage, chatId)).at(-1);
      if (answer?.role !== "assistant" || answer.status !== "complete") return null;
      const text = lastReplyParts(answer.parts)
        .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
        .filter(Boolean)
        .join("\n\n");
      return text || null;
    } catch (error) {
      console.error(`Пробный ход консультанта не удался (лидмагнит ${leadMagnetId}):`, error instanceof Error ? error.message : error);
      return null;
    } finally {
      await flow.end({ ownerId, chatId, reason: TRIAL_TURN_REASON }).catch(() => undefined);
      tails.set(chatId, null);
      await chatStorage.deleteChat(chatId).catch(() => undefined);
      await db.delete(previewConversations).where(eq(previewConversations.chatId, chatId));
    }
  }

  const flowTest = createFlowTestRoutes({ db, flow, ownerOf, pinToFlow, ensurePreview: (id) => endpoint.ensurePreview(id), restartPreview: startChat });

  const endpoint: PreviewEndpoint = {
    async fetch(request) {
      // Вход — первым: без него ни записей, ни ответов о состоянии разговора
      if (!(await options.resolveUser(request))) return Response.json({ error: "unauthenticated" }, { status: 401 });

      const segments = new URL(request.url).pathname.slice(PREVIEW_BASE_PATH.length + 1).split("/");
      // Адреса тестового чата для доски: свои права и свои ответы, до обычного чата
      if (segments[0] === "flow-test" || segments[1] === "flow-test") return flowTest.handle(request, segments);
      if (segments[0] && segments[1] === "corrections") return handleCorrections(request, segments);
      const requestedChat = segments[0] ? decodeURIComponent(segments[0]) : "";
      // Без чата (меню моделей, настройки вложений) — сервис без лидмагнита: такие запросы модель не зовут
      if (!requestedChat || requestedChat === "models" || requestedChat === "attachments") return plain().fetch(request);

      const lead = await findLeadMagnetByPreviewChat(db, requestedChat);
      if (!lead) {
        if (await readPreviewConversation(db, requestedChat))
          return Response.json(
            { error: { kind: "stale_preview", message: "Этот тестовый разговор уже начат заново. Обновите страницу, чтобы продолжить в новом." } },
            { status: 409 },
          );
        return Response.json({ error: { kind: "not_found" } }, { status: 404 });
      }
      const chatId = lead.previewChatId!;

      // Модель сменили в настройках — разговор продолжается на новой
      const choice = options.modelChoice(lead.draft);
      const chat = await chatStorage.getChat(chatId);
      if (chat && (chat.modelId !== choice.modelId || chat.providerId !== choice.providerId || chat.reasoning !== choice.reasoning))
        await chatStorage.updateChatModel(chatId, choice);

      const { handler } = await serverFor(await liveConsultantVersion(db, lead.draftVersionId, lead.draft));
      if (!turnChatId(request, PREVIEW_BASE_PATH)) return handler.fetch(request);

      const state = await readPreviewConversation(db, chatId);
      if (state?.finishedAt) {
        // Правка своей реплики или «Переделать» уводят разговор на ветку до конца: он снова идёт
        if (segments[1] === "edit" || segments[1] === "regenerate") {
          try {
            await reopen(chatId);
          } catch (error) {
            if (!(error instanceof PreviewReopenRefused)) throw error;
            return Response.json({ error: { kind: "finished", message: error.message } }, { status: 409 });
          }
        } else
          return Response.json(
            {
              error: {
                kind: "finished",
                message: "Тестовый разговор завершён. Нажмите «Продолжить разговор», чтобы писать дальше, или «Начать проверку заново».",
              },
            },
            { status: 409 },
          );
      }
      // Инструкции правили — разговор и с прошлой реплики, и дальше идёт по текущему черновику
      await moveTestChatToDraft(flow, { leadMagnetId: lead.id, chatId, draftVersionId: lead.draftVersionId, draftFlow: lead.draft.flow })
        .catch((error: unknown) => console.error(`Тестовый чат ${chatId} не переведён на черновик:`, error instanceof Error ? error.message : error));
      const branch = await loadCurrentBranch(chatStorage, chatId);
      const sent = branch.filter((message) => message.role === "user").length;
      const isNewMessage = segments[1] === "messages";
      const personMessageCount = sent + (isNewMessage ? 1 : 0);
      tails.set(chatId, buildConsultantTail({ settings: lead.draft, personMessageCount }));
      return handler.fetch(request);
    },

    async ensurePreview(leadMagnetId) {
      const lead = await getLeadMagnet(db, leadMagnetId);
      if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
      return lead.previewChatId ?? startChat(leadMagnetId);
    },

    restartPreview: startChat,

    async status(leadMagnetId) {
      const lead = await getLeadMagnet(db, leadMagnetId);
      if (!lead?.previewChatId) return null;
      const chatId = lead.previewChatId;
      const [state, run] = await Promise.all([readPreviewConversation(db, chatId), ownerOf(chatId).then((owner) => flow.readRun(owner, chatId))]);
      const node = run ? lead.draft.flow.states.find((candidate) => candidate.id === run.state) : lead.draft.flow.states[0];
      return {
        chatId: lead.previewChatId,
        stageName: node?.title ?? null,
        day: run?.day ? Math.max(1, run.day.day) : lead.draft.flow.schedule ? 1 : null,
        days: lead.draft.flow.schedule?.lengthDays ?? null,
        // Конец сценария приложение записывает в `finishedAt` (`onFinish`); «Продолжить разговор» его снимает
        finished: Boolean(state?.finishedAt),
      };
    },

    async suggestReply(chatId) {
      const lead = await leadOfChat(chatId);
      const branch = await loadCurrentBranch(chatStorage, chatId);
      const deps = { catalog: options.catalog, ...(options.env && { env: options.env }) };
      return withDirectModel(deps, options.modelChoice(lead.draft), chatId, (direct) => suggestClientReply({ direct, lead: lead.draft, branch }));
    },

    async reopenPreview(leadMagnetId) {
      const lead = await getLeadMagnet(db, leadMagnetId);
      if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
      if (lead.previewChatId && (await readPreviewConversation(db, lead.previewChatId))?.finishedAt) await reopen(lead.previewChatId);
    },

    async nextDay(leadMagnetId, timeZone) {
      const lead = await getLeadMagnet(db, leadMagnetId);
      if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
      await flowTest.advanceToNextDay(lead, timeZone);
    },

    async advanceBy(leadMagnetId, ms, timeZone) {
      const lead = await getLeadMagnet(db, leadMagnetId);
      if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
      return flowTest.advanceBy(lead, ms, timeZone);
    },

    async advanceToNextFirstMessage(leadMagnetId, timeZone) {
      const lead = await getLeadMagnet(db, leadMagnetId);
      if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
      return flowTest.advanceToNextFirstMessage(lead, timeZone);
    },

    consultantWouldAnswer,

    flow,
  };
  return endpoint;
}

/** Дочитывает поток хода: ответ пишется в хранилище по ходу. */
async function drainStream(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done);
}
