import { randomUUID } from "node:crypto";
import { loadCurrentBranch, type ChatStorage, type ModelCatalog, type ModelChoice } from "@ykurilov/agent-chat-core";
import { flowTestChatData } from "@ykurilov/agent-chat-flows";
import { createChatHandler, createChatServer, type ChatHandler } from "@ykurilov/agent-chat-server";
import type { Pool } from "pg";
import { createFlowLog } from "../flows/flow-log";
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
import { createPreviewConversationStore, readPreviewConversation, startPreviewConversation } from "./preview-store";
import { consultantStepContext } from "./step-context";
import { leadMagnetImageSource } from "../images";
import { leadMagnetVideoSource } from "../videos";
import { consultantAgentSettings, liveVersionKey, VersionCache, withLiveMedia } from "./services";
import { consultantReplyChecks } from "./reply-checks";
import { singleReplyStorage } from "./single-reply";
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
  /** «Начать заново»: новый разговор с первым сообщением лидмагнита. */
  restartPreview(leadMagnetId: string): Promise<string>;
  status(leadMagnetId: string): Promise<PreviewStatus | null>;
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
  /** Сценарий тестовых разговоров: место чата для доски (`readRun`). */
  flow: LeadMagnetFlow;
}

const SERVICES_IN_MEMORY = 20;

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
  const serverFor = (versionId: string, settings: LeadMagnetSettings): Promise<PreviewServer> =>
    servers.get(liveVersionKey(versionId, settings), async () =>
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
          replyChecks: consultantReplyChecks({ db, settings }),
          logError: (line: string) => void logError(line),
          catalog: options.catalog,
          defaultChoice: options.modelChoice(settings),
          ...(options.env && { env: options.env }),
          resolveUser,
          // «Проверка» изображает мессенджер: там поправки на лету нет, и ответ на ход один. Пометки «Агент написал первым —
          // человек молчал…» видит только эксперт в тестовом разговоре: боевые чаты и конструктор их не получают
          chatCapabilities: () => ({ steer: false, appNotices: true }),
          agent: consultantAgentSettings({
            settings,
            store,
            videos: leadMagnetVideoSource(db, settings.videoIds),
            images: leadMagnetImageSource(db, settings.imageIds),
            personLink,
            stepContext,
            dayOf,
          }),
        }),
      ),
    );
  /** Служба тестового разговора по его чату: черновик лидмагнита, у которого этот чат открыт в «Проверке». */
  async function serverOfChat(chatId: string): Promise<PreviewServer> {
    const lead = await findLeadMagnetByPreviewChat(db, chatId);
    const preview = lead ? null : await readPreviewConversation(db, chatId);
    const owner = lead ?? (preview && (await getLeadMagnet(db, preview.leadMagnetId)));
    if (!owner) throw new Error(`Чат ${chatId} — не тестовый разговор`);
    return serverFor(owner.draftVersionId, await withLiveMedia(db, owner.draft));
  }
  flow.attachPorts(async ({ chatId }) => (await serverOfChat(chatId)).service);

  let plainHandler: ChatHandler | undefined;
  const plain = () =>
    (plainHandler ??= createChatHandler({
      basePath: PREVIEW_BASE_PATH,
      storage: chatStorage,
      catalog: options.catalog,
      ...(options.env && { env: options.env }),
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
    await setPreviewChat(db, leadMagnetId, chatId);
    return chatId;
  }

  const flowTest = createFlowTestRoutes({ db, flow, ownerOf, pinToFlow, ensurePreview: (id) => endpoint.ensurePreview(id), restartPreview: startChat });

  const endpoint: PreviewEndpoint = {
    async fetch(request) {
      // Вход — первым: без него ни записей, ни ответов о состоянии разговора
      if (!(await options.resolveUser(request))) return Response.json({ error: "unauthenticated" }, { status: 401 });

      const segments = new URL(request.url).pathname.slice(PREVIEW_BASE_PATH.length + 1).split("/");
      // Адреса тестового чата для доски: свои права и свои ответы, до обычного чата
      if (segments[0] === "flow-test" || segments[1] === "flow-test") return flowTest.handle(request, segments);
      const requestedChat = segments[0] ? decodeURIComponent(segments[0]) : "";
      // Без чата (меню моделей) — сервис без лидмагнита: такие запросы модель не зовут
      if (!requestedChat || requestedChat === "models") return plain().fetch(request);

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

      const { handler } = await serverFor(lead.draftVersionId, await withLiveMedia(db, lead.draft));
      if (!turnChatId(request, PREVIEW_BASE_PATH)) return handler.fetch(request);

      const state = await readPreviewConversation(db, chatId);
      if (state?.finishedAt)
        return Response.json(
          { error: { kind: "finished", message: "Тестовый разговор завершён. Нажмите «Начать проверку заново», чтобы пройти его ещё раз." } },
          { status: 409 },
        );
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
      const state = await readPreviewConversation(db, lead.previewChatId);
      const run = await flow.readRun(await ownerOf(lead.previewChatId), lead.previewChatId);
      const node = run ? lead.draft.flow.states.find((candidate) => candidate.id === run.state) : lead.draft.flow.states[0];
      return {
        chatId: lead.previewChatId,
        stageName: node?.title ?? null,
        day: run?.day ? Math.max(1, run.day.day) : lead.draft.flow.schedule ? 1 : null,
        days: lead.draft.flow.schedule?.lengthDays ?? null,
        finished: Boolean(state?.finishedAt || run?.endedAt !== undefined),
      };
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

    flow,
  };
  return endpoint;
}
