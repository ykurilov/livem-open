import { randomUUID } from "node:crypto";
import {
  ChatBusyError,
  createChatService,
  type AbandonedBurstsOptions,
  type ChatErrorKind,
  type ChatEvent,
  type ChatService,
  type ChatStorage,
  type ModelCatalog,
  type ModelChoice,
  type RunningAnswerRegistry,
  type SpendingLimits,
  type StoredMessage,
} from "@ykurilov/agent-chat-core";
import type { FlowPort } from "@ykurilov/agent-chat-flows";
import { eq } from "drizzle-orm";
import { passages } from "../conversations/schema";
import { createFlowLog } from "../flows/flow-log";
import { cacheMissLog } from "./cache-miss-log";
import { agentFlowOf, loadLeadMagnetFlow, type LeadMagnetFlow } from "../flows/runtime";
import { getLeadMagnet, getVersion, type LeadMagnetSettings } from "../lead-magnets";
import type { Database } from "../platform/db";
import { AGENT_TIME_ZONE } from "../platform/models-catalog";
import { readPreviewConversation, type ConversationStore } from "./preview-store";
import { leadMagnetImageSource, type ShownImage } from "../images";
import { leadMagnetVideoSource, type ShownVideoLink } from "../videos";
import { consultantAgentSettings, liveVersionKey, VersionCache, withLiveMedia } from "./services";
import { consultantReplyChecks } from "./reply-checks";
import { mediaSentWith } from "./sent-media";
import { lastReplyParts, singleReplyStorage } from "./single-reply";
import { personLinkFromEnv } from "./person-link";
import { createTurnTails } from "../platform/turn-tails";
import { consultantStepContext } from "./step-context";
import { nameUsedRecently, profileNameForTail } from "./profile-name";
import type { FirstMessageWriter } from "../purchases/reactions";

/** Имя служебного сообщения события приложения для модели и «Лога». */
const APP_EVENT_NOTICE = "app_event";

export interface HeadlessConsultantOptions {
  db: Database;
  chatStorage: ChatStorage;
  catalog: ModelCatalog;
  env?: Record<string, string | undefined>;
  registry?: RunningAnswerRegistry;
  /** Куда инструменты пишут состояние разговора. */
  store: ConversationStore;
  /** Модель консультанта по настройкам снимка. */
  modelChoice(settings: LeadMagnetSettings): ModelChoice;
  /** Лимиты расходов: исчерпан — ход не начинается, `SpendingLimitReachedError`. */
  limits?: SpendingLimits;
  /** Сценарии лидмагнитов: служба каждой версии идёт через `flow.withChat`, таймеры сценария будят её через `portFor`. */
  flow: LeadMagnetFlow;
  /** Часы службы чата: те же, что у сценария (`platform/clock`); тесты и eval подменяют их целиком. */
  now?: () => Date;
  /**
   * Сообщения хода записаны пачкой SDK, ход ждёт окна тишины (`BURST_QUIET_MS`) по часам службы. Подменившие часы (тесты,
   * eval) сдвигают их здесь, служба тут же сверяет срок (`tickBursts`). Боевому работнику не нужно: часы идут сами.
   */
  afterBurstRecorded?: (window: { quietMs: number }) => void;
  /**
   * Ход на пачку начинается — и у вызова, и без него (после перезапуска): приложение отмечает сообщения хода и даёт хвост
   * хода. `null` — чат не разговор приложения, хвост прежний.
   */
  onBurstTurn?(input: { ownerId: string; chatId: string; burstMessageIds: string[] }): Promise<{ tail: string | null } | null>;
  /** Ход на пачку не начался из-за лимита расходов: отметки `onBurstTurn` снимаются, утром — ход на всё. */
  onBurstTurnRefused?(input: { chatId: string; burstMessageIds: string[] }): Promise<void>;
  /**
   * Ход на пачку без вызова закончен (пачку бросил упавший или перезапущенный работник, ответил обход SDK): ответ в
   * истории, человеку его доставляет приложение.
   */
  onUnattendedAnswer?(input: { ownerId: string; chatId: string; answerId: string }): Promise<void>;
  /** Каждая строка журнала служб консультанта (`logError`): приложение ищет в нём, о чём сказать владельцу. */
  onLogLine?(line: string): void;
}

/** Виды ошибок SDK, которые значат «провайдер сейчас не может»: сеть, 5xx, таймаут, 429. Их стоит переждать. */
const PROVIDER_FAILURE_KINDS: ReadonlySet<string> = new Set<ChatErrorKind>(["overloaded", "rate_limited"]);

const ERROR_KIND_REASONS: Record<ChatErrorKind, string> = {
  overloaded: "провайдер перегружен или недоступен",
  rate_limited: "провайдер ограничил частоту запросов",
  insufficient_funds: "на счёте провайдера кончились деньги",
  invalid_key: "ключ провайдера не подходит",
  context_overflow: "разговор стал слишком длинным для консультанта",
  other: "провайдер отклонил запрос, повтор не поможет",
};

/** Ход не закончился ответом (ошибка модели, прерывание, остановка работника). */
export class ConsultantTurnFailedError extends Error {
  constructor(
    readonly status: string,
    readonly errorKind?: ChatErrorKind,
    /** Ход остановила штатная остановка работника (`flush`): ни модель, ни разговор не виноваты, ход повторится. */
    readonly byShutdown = false,
    /** Сообщение человека, на которое не вышло ответа: последнее сообщение пачки. */
    readonly questionId?: string,
  ) {
    super(
      `Ход консультанта не закончился ответом (статус: ${status}${errorKind ? `, ошибка: ${errorKind}` : ""}${byShutdown ? ", остановка работника" : ""})`,
    );
    this.name = "ConsultantTurnFailedError";
  }

  /** Причина для эксперта. Текста ошибки SDK не хранит — только её вид. */
  get reason(): string {
    if (this.status !== "error" || this.errorKind === undefined) return `ход оборвался (статус: ${this.status})`;
    return ERROR_KIND_REASONS[this.errorKind];
  }

  /** Сбой провайдера: повтор позже поможет. Длинный контекст, отказ по содержимому, ключ, деньги, наши ошибки — нет. */
  get isProviderFailure(): boolean {
    return this.status === "error" && this.errorKind !== undefined && PROVIDER_FAILURE_KINDS.has(this.errorKind);
  }
}

export interface HeadlessTurn {
  /** Снимок лидмагнита: у каждого снимка свой сервис с неизменной инструкцией (кэш модели). */
  snapshotId: string;
  settings: LeadMagnetSettings;
  /** Владелец чата — человек (`people.id`). */
  ownerId: string;
  chatId: string;
  /**
   * Сообщения человека на этот ход по порядку — пачкой SDK: в истории каждое отдельно, модель видит их одним сообщением.
   * Тот же id при повторе — то же сообщение, без второй записи.
   */
  messages: ReadonlyArray<{ id: string; text: string }>;
  /**
   * Ход приложения, если сообщения уже отмечены прошлым ходом. До SDK 0.54 сообщения хода склеивались в одно сообщение
   * SDK с этим id: повтор такого хода — по нему.
   */
  turnId?: string;
  /** Меняющееся (этап, отсчёт, пометки) — хвостом в конец запроса каждого шага, в историю не пишется. */
  tail: string | null;
  /** Пояс человека (IANA) для блока SDK «Сегодня»; не задан — Москва. Блок идёт в хвосте: кэш цел. */
  timeZone?: string;
  /**
   * Ответы эксперта человеку из «Входящих» за разговор; уже записанные в историю пропускаются (`id` — id исходящего).
   * `staffName` — имя эксперта; нет — модель видит просто «сотрудник».
   */
  expertReplies: ReadonlyArray<{ id: string; text: string; staffName: string | null }>;
}

export interface TurnAnswer {
  /** Сообщение человека, на которое ответ: последнее сообщение пачки. */
  questionId: string;
  /** Ответ консультанта в истории; нет — ответа нет (`held`, `elsewhere`). */
  answerId?: string;
  text: string;
  /** Ролик к ответу: первый показанный, если его не показывали в разговоре раньше. */
  video: ShownVideoLink | null;
  /** Картинка к ответу: первая показанная, если её не показывали в разговоре раньше. */
  image: ShownImage | null;
  /**
   * Сценарий записал сообщение без хода (ворота хода SDK): после жёсткой рамки дня — до утра, на паузе сотрудника,
   * после конца разговора. Ответа нет, человеку ничего не уходит.
   */
  held?: true;
  /**
   * Отвечает не этот вызов: следующее сообщение пачки пришло позже (ответит его ход) или ход уже идёт без вызова.
   * Ответ доставит тот, кто отвечает.
   */
  elsewhere?: true;
}

export interface HeadlessConsultant {
  /** Служба чата этого разговора для сценария: снимок прохождения или черновик тестового разговора. */
  portFor(chat: { ownerId: string; chatId: string }): Promise<FlowPort>;
  /** Новый чат человека с первым сообщением лидмагнита от консультанта. */
  startConversation(input: { ownerId: string; settings: LeadMagnetSettings; firstMessage: string }): Promise<string>;
  /** Ход консультанта; возвращает текст ответа и ролики, которые консультант показал. */
  runTurn(turn: HeadlessTurn): Promise<TurnAnswer>;
  /** Сколько стоил разговор, $: по журналу расхода SDK. */
  chatCost(chatId: string): Promise<number>;
  /** Ответ консультанта из истории чата — тем же видом, что у хода. */
  answerOf(answerId: string): Promise<(TurnAnswer & { status: StoredMessage["status"]; errorKind?: ChatErrorKind }) | null>;
  /**
   * Запуск работника: прерванные ответы помечаются, брошенные пачки (`answerAfterRestart`) получают ход у службы своей
   * версии; дальше обход идёт сам. Подписка на события служб — до него.
   */
  recoverAnswers(): Promise<void>;
  /** Обход пачек сейчас — по подменённым часам (тесты, eval): ждущие сверяют срок, брошенные получают ход. */
  tickBursts(): Promise<void>;
  /** Доставка ответов на брошенные пачки, начатая к этому моменту, закончена (тесты). */
  settled(): Promise<void>;
  /**
   * Последний ответ, который приложение склеивает с прощанием (`finish_dialog.answer`), — через те же проверки ответа,
   * что и ответ модели: `service.checkReply` службы этого разговора.
   */
  checkedClosingAnswer(input: { ownerId: string; chatId: string; messageId: string; answer: string }): Promise<string>;
  /**
   * Агент пишет первым по событию приложения (оплата, напоминание): служебное сообщение в историю (модель видит
   * `title`), ход, готовый проверенный ответ — доставляет приложение. Повтор с тем же `deliveryKey` не пишет второе
   * служебное сообщение и отдаёт уже готовый ответ.
   */
  writeFirst: FirstMessageWriter["writeFirst"];
  /**
   * Штатная остановка работника, до закрытия хранилища: новые ходы не начинаются, идущие дорабатывают до срока,
   * не успевшие останавливаются — их `runTurn` бросают `ConsultantTurnFailedError` с `byShutdown`.
   */
  flush(options: { waitForAnswersMs: number }): Promise<void>;
}

const SERVICES_IN_MEMORY = 50;

/** Окно тишины пачки SDK, мс: сообщения человека, пришедшие за это время одно за другим, уйдут консультанту одним ходом. */
export const BURST_QUIET_MS = 4000;

/** Консультант без браузера: ход через ядро SDK, ответ — текстом для мессенджера. */
export function createHeadlessConsultant(options: HeadlessConsultantOptions): HeadlessConsultant {
  const chatStorage = singleReplyStorage(options.chatStorage);
  const services = new VersionCache<ChatService>(SERVICES_IN_MEMORY);
  const personLink = personLinkFromEnv(options.env ?? process.env, options.chatStorage);
  const tails = createTurnTails();
  const flowLog = createFlowLog(options.db, (chatId) => loadLeadMagnetFlow(options.db, chatId));
  const stepContext = consultantStepContext({
    tails,
    store: options.store,
    readRun: (ownerId, chatId) => options.flow.readRun(ownerId, chatId),
    onFirstReasons: (reasons) => flowLog.firstMessage(reasons),
    // Пока человек не сказал, как к нему обращаться; у тестового разговора эксперта имени из профиля нет
    personNameOf: (ownerId) => profileNameForTail(options.db, ownerId),
    nameUsedRecently: (ownerId, chatId) => nameUsedRecently({ db: options.db, chatStorage: options.chatStorage }, ownerId, chatId),
  });
  const dayOf = async ({ ownerId, chatId }: { ownerId: string; chatId: string }) => (await options.flow.readRun(ownerId, chatId))?.day?.day ?? 1;
  // Промах кэша — с днём программы и нодой чата: так промахи раскладываются по дням и нодам
  const logError = cacheMissLog({
    ownerOf: async (chatId) => (await options.chatStorage.getChat(chatId))?.ownerId ?? null,
    readRun: (ownerId, chatId) => options.flow.readRun(ownerId, chatId),
    log: (line) => console.error(line),
  });
  // Ход, остановленный во время остановки, — «Стоп» службы, а не сбой: «Стопа» и срока хода у бота нет
  let shuttingDown = false;
  const unattended = new Set<Promise<void>>();

  /**
   * Брошенная пачка — службе версии своего чата: у каждой версии своя инструкция. Службы нет — создаётся. Чат не разговор
   * лидмагнита или ошибка — `null`: пачку никто не берёт, SDK спросит снова на следующем обходе.
   */
  const abandonedBursts: AbandonedBurstsOptions = {
    async serviceFor({ chatId }) {
      try {
        return await serviceOfChat(chatId);
      } catch (error) {
        console.error(`Брошенная пачка чата ${chatId} без службы:`, error instanceof Error ? error.message : error);
        return null;
      }
    },
  };

  /** Ход на брошенную пачку идёт без вызова: дождаться конца и отдать ответ приложению. */
  function followUnattended(service: ChatService, event: ChatEvent): void {
    if (event.type !== "turn-started" || !event.unattended) return;
    const following = (async () => {
      const stream = await service.subscribe(event.ownerId, event.chatId);
      if (stream) await drain(stream);
      await options.onUnattendedAnswer?.({ ownerId: event.ownerId, chatId: event.chatId, answerId: event.messageId });
    })()
      .catch((error) => console.error(`Ответ на брошенную пачку чата ${event.chatId} не доставлен:`, error instanceof Error ? error.message : error))
      .finally(() => unattended.delete(following));
    unattended.add(following);
  }

  /** Отметки хода приложения — у хода на пачку; хвост хода — от них. */
  const burstTurnHooks = {
    beforeTurn: async ({ userId, chat, burstMessageIds }: { userId: string; chat: { id: string }; burstMessageIds?: string[] }) => {
      if (!burstMessageIds || !options.onBurstTurn) return;
      const turn = await options.onBurstTurn({ ownerId: userId, chatId: chat.id, burstMessageIds });
      if (turn) tails.set(chat.id, turn.tail);
    },
    turnNotStarted: async ({ chat, burstMessageIds, reason }: { chat: { id: string }; burstMessageIds?: string[]; reason: string }) => {
      if (burstMessageIds && reason === "spending_limit") await options.onBurstTurnRefused?.({ chatId: chat.id, burstMessageIds });
    },
  };

  // Служба без своей инструкции: только помечает прерванные ответы и обходит брошенные пачки, отдавая их службам версий
  const recovery = createChatService({
    storage: chatStorage,
    catalog: options.catalog,
    ...(options.registry && { registry: options.registry }),
    ...(options.now && { now: options.now }),
    agent: { instructions: "" },
    abandonedBursts,
  });

  const serviceFor = (snapshotId: string, settings: LeadMagnetSettings) =>
    services.get(liveVersionKey(snapshotId, settings), async () => {
      const service = createChatService(
        options.flow.withChat({
          abandonedBursts,
          ...burstTurnHooks,
          // Ответ человеку один на ход; чужие слова и выдуманные ссылки проверяет служба SDK до записи
          storage: singleReplyStorage(options.chatStorage),
          logError: (line: string) => {
            options.onLogLine?.(line);
            void logError(line);
          },
          replyChecks: consultantReplyChecks({ db: options.db, settings }),
          catalog: options.catalog,
          ...(options.registry && { registry: options.registry }),
          ...(options.limits && { limits: options.limits }),
          defaultChoice: options.modelChoice(settings),
          ...(options.env && { env: options.env }),
          ...(options.now && { now: options.now }),
          agent: consultantAgentSettings({
            settings,
            store: options.store,
            videos: leadMagnetVideoSource(options.db, settings.videoIds),
            images: leadMagnetImageSource(options.db, settings.imageIds),
            personLink,
            stepContext,
            dayOf,
          }),
        }),
      );
      // До того как служба возьмёт первую брошенную пачку: ответ без вызова доставляет приложение
      service.subscribeEvents((event) => followUnattended(service, event));
      return service;
    });

  /** Служба разговора по его чату: прохождение — на своём снимке, тестовый разговор — на черновике. */
  async function serviceOfChat(chatId: string): Promise<ChatService> {
    const [passage] = await options.db.select({ snapshotId: passages.snapshotId }).from(passages).where(eq(passages.chatId, chatId));
    if (passage) {
      const snapshot = await getVersion(options.db, passage.snapshotId);
      if (!snapshot) throw new Error(`Снимок ${passage.snapshotId} не найден`);
      return serviceFor(passage.snapshotId, await withLiveMedia(options.db, snapshot.settings));
    }
    const preview = await readPreviewConversation(options.db, chatId);
    const lead = preview && (await getLeadMagnet(options.db, preview.leadMagnetId));
    if (!lead) throw new Error(`Чат ${chatId} — не разговор лидмагнита`);
    return serviceFor(lead.draftVersionId, await withLiveMedia(options.db, lead.draft));
  }

  /**
   * Ответы эксперта — в конец ветки, до нового сообщения человека, ровно один раз: репликой сотрудника SDK
   * (`appendStaffMessage`). Модель видит, что ответил живой сотрудник; словами человека реплика не считается.
   * Пишутся в историю после прошлых сообщений — начало запроса то же, кэш цел. Записанные до SDK 0.53 своей
   * пометкой (id сообщения = id исходящего) второй раз не пишутся.
   */
  async function appendExpertReplies(service: ChatService, turn: HeadlessTurn): Promise<void> {
    for (const reply of turn.expertReplies) {
      if (await chatStorage.getMessage(reply.id)) continue;
      const { status } = await service.appendStaffMessage({
        ownerId: turn.ownerId,
        chatId: turn.chatId,
        text: reply.text,
        ...(reply.staffName && { staffName: reply.staffName }),
        deliveryKey: `inbox:${reply.id}`,
      });
      if (status !== "delivered") throw new Error(`Ответ эксперта не записан в историю чата ${turn.chatId}: ${status}`);
    }
  }

  /** Пояс для блока SDK «Сегодня». */
  const pageOf = (turn: HeadlessTurn) => ({ timeZone: turn.timeZone ?? AGENT_TIME_ZONE });

  /**
   * Сообщения хода — пачкой SDK, по порядку. Ход на пачку начинает вызов последнего сообщения пачки; поток — у него.
   * Возвращает начатые ходы с сообщением, на которое ответ: обычно один, ни одного — если ответ уже есть, отвечает
   * следующее сообщение или ход идёт без вызова.
   */
  async function sendBurst(service: ChatService, turn: HeadlessTurn, page: { timeZone: string }): Promise<Array<{ questionId: string; stream: ReadableStream<unknown> }>> {
    // Задачи одного разговора пишут сообщения по очереди: одно и то же сообщение не пишется двумя вызовами разом
    const turns = await recordingInOrder(turn.chatId, async () => {
      const recorded: Array<Promise<{ questionId: string; stream: ReadableStream<unknown> | null }>> = [];
      if (!(await chatStorage.getMessage(turn.messages[0]!.id))) {
        // Лимит — до записи, как у `sendMessage`: пачка пишется сразу, а отказ при начале хода оставил бы её в истории
        // без ответа, и утренняя пачка легла бы отдельно, за пометкой «ход оборвался»
        await service.assertWithinLimit(turn.ownerId, turn.chatId);
        await appendExpertReplies(service, turn);
      }
      for (const message of turn.messages) {
        const { turn: started } = await service.sendBurstMessage(
          turn.ownerId,
          turn.chatId,
          { id: message.id, role: "user", parts: [{ type: "text", text: message.text }] },
          // Упадёт работник посреди окна — пачку запомнит хранилище, ответит обход нового работника
          { page, quietMs: BURST_QUIET_MS, answerAfterRestart: true },
        );
        recorded.push(started.then((stream) => ({ questionId: message.id, stream })));
      }
      return recorded;
    });
    if (options.afterBurstRecorded) {
      options.afterBurstRecorded({ quietMs: BURST_QUIET_MS });
      await service.tickBursts();
    }
    return (await Promise.all(turns)).flatMap(({ questionId, stream }) => (stream ? [{ questionId, stream }] : []));
  }

  /** Запись сообщений разговора — по одной задаче за раз, ожидание хода — уже вместе. */
  const recordings = new Map<string, Promise<unknown>>();
  async function recordingInOrder<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const previous = recordings.get(chatId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    recordings.set(chatId, current);
    try {
      return await current;
    } finally {
      if (recordings.get(chatId) === current) recordings.delete(chatId);
    }
  }

  async function finishedAnswer(chatId: string, question: string, held = false): Promise<TurnAnswer> {
    const answer = await answerTo(chatId, question);
    if (!answer && held) return { questionId: question, text: "", video: null, image: null, held: true };
    if (answer?.status !== "complete")
      throw new ConsultantTurnFailedError(answer?.status ?? "нет ответа", answer?.error?.kind, shuttingDown && answer?.status === "stopped", question);
    return answerOf(chatStorage, answer);
  }

  /** Последний ответ на сообщение человека: после повтора их может быть несколько. */
  async function answerTo(chatId: string, messageId: string): Promise<StoredMessage | undefined> {
    const messages = await chatStorage.listMessages(chatId);
    return messages.filter((message) => message.role === "assistant" && message.parentId === messageId).at(-1);
  }

  return {
    portFor: ({ chatId }) => serviceOfChat(chatId),

    async startConversation({ ownerId, settings, firstMessage }) {
      const chatId = randomUUID();
      await chatStorage.createChat({ id: chatId, ownerId, ...options.modelChoice(settings) });
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
      return chatId;
    },

    async runTurn(turn) {
      const service = await serviceFor(turn.snapshotId, await withLiveMedia(options.db, turn.settings));
      const page = pageOf(turn);
      // Ход, начатый до SDK 0.54 одним склеенным сообщением, повторяется по нему: иначе слова человека легли бы в историю дважды
      if (turn.messages.length === 0) throw new Error("Ход без сообщений человека с текстом");
      const legacy = turn.turnId ? await chatStorage.getMessage(turn.turnId) : undefined;
      const question = legacy?.role === "user" ? turn.turnId! : turn.messages.at(-1)!.id;

      try {
        if (legacy?.role !== "user") {
          const started = await sendBurst(service, turn, page);
          if (started.length > 0) {
            let held = false;
            for (const { stream } of started) held = (await drain(stream)) || held;
            return await finishedAnswer(turn.chatId, started.at(-1)!.questionId, held);
          }
        }
        // Ход на пачку не начался здесь: ответ уже есть, идёт без вызова (после перезапуска), отвечает следующее
        // сообщение или прошлый ход упал до ответа. Ответы эксперта сюда не дописываются: они войдут в следующий ход
        const answered = await answerTo(turn.chatId, question);
        if (answered?.status === "complete") return answerOf(chatStorage, answered);
        if (answered?.status === "streaming") {
          const stream = await service.subscribe(turn.ownerId, turn.chatId);
          if (stream) await drain(stream);
          return await finishedAnswer(turn.chatId, question);
        }
        // Ответа нет: пачку решает ход следующего сообщения, другой вызов или обход SDK — ответ доставит он
        if (!answered && legacy?.role !== "user") return { questionId: question, text: "", video: null, image: null, elsewhere: true };
        if (!answered && (await options.flow.admit({ ownerId: turn.ownerId, chatId: turn.chatId })).kind !== "answer")
          return { questionId: question, text: "", video: null, image: null, held: true };
        // Хвост хода — в `tails`, он ложится в конец запроса каждого шага. У хода на пачку его ставит начало хода
        // (`onBurstTurn`): пока идёт ответ, задача нового сообщения не перепишет его старым счётом
        tails.set(turn.chatId, turn.tail);
        return await finishedAnswer(turn.chatId, question, await drain(await service.retry(turn.ownerId, turn.chatId, page)));
      } catch (error) {
        // Остановка работника посреди окна пачки: пачку помнит хранилище, ответит обход нового работника
        if (error instanceof ChatBusyError && shuttingDown) return { questionId: question, text: "", video: null, image: null, elsewhere: true };
        throw error;
      }
    },

    async answerOf(answerId) {
      const message = await chatStorage.getMessage(answerId);
      if (message?.role !== "assistant") return null;
      return { ...(await answerOf(chatStorage, message)), status: message.status, ...(message.error && { errorKind: message.error.kind }) };
    },

    async recoverAnswers() {
      await recovery.recoverInterruptedAnswers();
    },

    async tickBursts() {
      await Promise.all([recovery, ...services.values()].map((service) => service.tickBursts()));
    },

    async settled() {
      while (unattended.size > 0) await Promise.all(unattended);
    },

    async chatCost(chatId) {
      const sums = await chatStorage.sumUsage({ chatId });
      return sums.reduce((total, sum) => total + sum.costUsd, 0);
    },

    async checkedClosingAnswer({ ownerId, chatId, messageId, answer }) {
      if (!answer.trim()) return answer;
      // Этот текст писала не модель в ходе, а инструмент: служба проверяет его тем же набором «виденного», что и ход
      const { text } = await (await serviceOfChat(chatId)).checkReply({ ownerId, chatId, text: answer, messageId });
      return text;
    },

    async writeFirst({ ownerId, chatId, deliveryKey, title, timeZone }) {
      const service = await serviceOfChat(chatId);
      // Хвост прошлого хода человека (отсчёт, вложения) к событию не относится
      tails.set(chatId, null);
      const result = await service.deliverNotices({
        ownerId,
        chatId,
        notices: [{ kind: "app", name: APP_EVENT_NOTICE, title }],
        wakeAgent: true,
        awaitAnswer: true,
        deliveryKey,
        usageSource: "first_message",
        ...(timeZone && { timeZone }),
      });
      if (result.status === "busy") return { kind: "busy" };
      if (result.status === "chat_gone" || !result.messageId) return { kind: "no_turn" };
      // Повтор после записанного ответа: ход не начинается, ответ — тот, что уже в истории
      const answer = result.answer ? await chatStorage.getMessage(result.answer.messageId) : await answerTo(chatId, result.messageId);
      if (!answer) return { kind: "no_turn" };
      if (answer.status !== "complete")
        throw new ConsultantTurnFailedError(answer.status, answer.error?.kind, shuttingDown && answer.status === "stopped", result.messageId);
      const { text, video, image } = await answerOf(chatStorage, answer);
      return { kind: "answer", text, video, image };
    },

    async flush({ waitForAnswersMs }) {
      shuttingDown = true;
      await Promise.all([recovery, ...services.values()].map((service) => service.flush({ waitForAnswersMs })));
      // Ответы на брошенные пачки, остановленные вместе со службой, встают в очередь заново — до закрытия базы
      await Promise.allSettled([...unattended]);
    },
  };
}

/** Служба записала сообщение без хода — часть `data-turn-held` в потоке (ворота хода сценария). */
const TURN_HELD_PART = "data-turn-held";

/** Ответы, сохранённые до страховки одного ответа, тоже уходят одним ответом. */
async function answerOf(chatStorage: ChatStorage, message: StoredMessage): Promise<TurnAnswer> {
  const parts = lastReplyParts(message.parts);
  return {
    questionId: message.parentId ?? "",
    answerId: message.id,
    text: parts
      .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
      .filter(Boolean)
      .join("\n\n"),
    ...(await mediaSentWith(chatStorage, message.chatId, message.id, parts)),
  };
}

/** Дочитывает поток хода: ответ пишется в хранилище по ходу. Возвращает, записала ли служба сообщение без хода. */
async function drain(stream: ReadableStream<unknown>): Promise<boolean> {
  const reader = stream.getReader();
  let held = false;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
    if ((chunk.value as { type?: string } | undefined)?.type === TURN_HELD_PART) held = true;
  return held;
}
