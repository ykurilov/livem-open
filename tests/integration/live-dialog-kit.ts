import { APICallError } from "ai";
// Общий набор для тестов живого диалога: база, подделка мессенджера, подставная модель, подменённые часы и очередь.
import { randomUUID } from "node:crypto";
import type { AgentFlow } from "@ykurilov/agent-chat-flows";
import { createInMemoryChatStorage, extendCatalog, type ChatStorage, type ModelCatalog, type ModelChoice, type UsageSource } from "@ykurilov/agent-chat-core";
import { eq } from "drizzle-orm";
import { createAlerts, type AlertService } from "@/modules/alerts";
import type { AttachmentKind, BotCredentials, ChannelEvent } from "@/modules/channels";
import { FakeChannel } from "@/modules/channels/fake";
import { bots, outboundMessages } from "@/modules/channels/schema";
import { BURST_QUIET_MS } from "@/modules/consultant/headless-turn";
import { createLiveDialog, type LiveDialog, type WebhookResponse } from "@/modules/conversations/live-dialog";
import { inboundMessages, passages } from "@/modules/conversations/schema";
import { createLeadMagnet, saveDraft, type LeadMagnetSettings } from "@/modules/lead-magnets";
import { attachBot, publishLeadMagnet } from "@/modules/lead-magnets/publish";
import { leadMagnets, leadMagnetVersions } from "@/modules/lead-magnets/schema";
import { newLeadMagnetSettings } from "@/modules/lead-magnets/settings";
import { people } from "@/modules/people/schema";
import { getFields } from "@/modules/people";
import { leadMagnetToFlow } from "@/modules/flows";
import { createFakeClock, type FakeClock } from "@/modules/platform/clock";
import { createTokenCipher } from "@/modules/platform/crypto";
import { STUB_MODEL_CHOICE, createAppCatalog } from "@/modules/platform/models-catalog";
import type { EnqueueOptions, JobEnqueuer, JobName, JobPayloads } from "@/modules/platform/queue";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "@/modules/platform/scripted-model";
import type { TestDatabase } from "./db-helper";

export const KIT_CIPHER = createTokenCipher(Buffer.alloc(32, 9).toString("base64"));

/** Цена подставной модели: $1 за 1000 токенов и входа, и выхода — чтобы расход был заметен. */
const PRICE_PER_MILLION = 1000;

export interface LiveDialogKitOptions {
  start?: Date;
  /** Изолированный fixture с фиксированным business id (production runtime не переопределяется). */
  leadMagnetId?: string;
  chatStorage?: ChatStorage;
  /** Цена подставной модели за миллион токенов. 0 — ходы бесплатны, расход задаёт сам тест через `spend`. */
  pricePerMillion?: number;
  /** Живой eval только судьи; реплики консультанта остаются fixture. */
  realJudge?: { choice: ModelChoice; env: Record<string, string | undefined> };
  /** Настоящая модель вместо подставной (замер скорости): каталог, выбор модели и окружение с ключом. */
  realModel?: { catalog: ModelCatalog; choice: ModelChoice; env: Record<string, string | undefined> };
}

interface QueuedJob {
  name: JobName;
  payload: unknown;
  runAt: number;
  singletonKey?: string;
}

/**
 * Очередь в памяти, как pg-boss по смыслу: задача с отсрочкой ждёт своего времени по подменённым часам,
 * вторая задача с тем же `singletonKey`, пока первая ждёт, не добавляется (политика `short`).
 */
export class FakeQueue implements JobEnqueuer {
  readonly pending: QueuedJob[] = [];
  readonly history: Array<{ name: JobName; payload: unknown; options?: EnqueueOptions }> = [];
  private failures = 0;

  constructor(private readonly clock: FakeClock) {}

  /** Ближайшие `count` постановок задач упадут. */
  failNext(count = 1): void {
    this.failures += count;
  }

  async enqueue<Name extends JobName>(name: Name, payload: JobPayloads[Name], options?: EnqueueOptions): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("Очередь недоступна");
    }
    this.history.push({ name, payload, options });
    const key = options?.singletonKey;
    if (key && this.pending.some((job) => job.name === name && job.singletonKey === key)) return;
    this.pending.push({
      name,
      payload,
      runAt: this.clock.now().getTime() + (options?.delaySeconds ?? 0) * 1000,
      ...(key && { singletonKey: key }),
    });
  }

  count(name: JobName): number {
    return this.history.filter((job) => job.name === name).length;
  }

  takeDue(except?: JobName): QueuedJob | undefined {
    const now = this.clock.now().getTime();
    const index = this.pending.findIndex((job) => job.runAt <= now && job.name !== except);
    if (index < 0) return undefined;
    return this.pending.splice(index, 1)[0];
  }

  nextRunAt(except?: JobName): number | undefined {
    const jobs = this.pending.filter((job) => job.name !== except);
    return jobs.length ? Math.min(...jobs.map((job) => job.runAt)) : undefined;
  }
}

export interface PublishedLeadMagnet {
  leadMagnetId: string;
  snapshotId: string;
  code: string;
}

export interface LiveDialogKit {
  db: TestDatabase["db"];
  channel: FakeChannel;
  clock: FakeClock;
  queue: FakeQueue;
  chatStorage: ChatStorage;
  dialog: LiveDialog;
  /** Тревоги набора; отправленные тексты копятся в `alertTexts`. */
  alerts: AlertService;
  alertTexts: string[];
  bot: BotCredentials;
  /** Запросы к модели консультанта. */
  calls: ScriptedCall[];
  /** Что отвечает модель; тест может подменить. */
  reply: (call: ScriptedCall) => ScriptedReply;
  /**
   * Сообщения хода записаны пачкой SDK: по умолчанию часы сдвигаются на окно тишины, и ход начинается. Тест может
   * подменить, например остановить работника посреди окна.
   */
  onBurstRecorded: (window: { quietMs: number }) => void;
  /**
   * Работник остановлен (`flush`) и запущен заново на тех же базе, очереди, хранилище и часах; как боевой работник, при
   * запуске обходит брошенные ответы и пачки (`recoverAnswers`).
   */
  restartWorker(): Promise<void>;
  /** Какие условия выхода словами судья сценария признаёт выполненными (id выходов); по умолчанию — никакие. */
  judge: (call: ScriptedCall) => string[];
  /** Запросы к модели консультанта без вопросов судьи. */
  consultantCalls(): ScriptedCall[];
  /** Что сценарий написал первым и доставил через бот набора, с часами отправки. */
  firstMessages(): Promise<Array<{ text: string; at: Date }>>;
  /** Лидмагнит с настройками консультанта, привязанный к боту набора и опубликованный; `adjustFlow` правит его сценарий. */
  publish(settings?: Partial<LeadMagnetSettings>, adjustFlow?: (flow: AgentFlow) => AgentFlow): Promise<PublishedLeadMagnet>;
  /** Сообщение человека через вебхук. Без `dedupeKey` — новое событие. */
  send(userId: string, text: string, extra?: { startCode?: string; attachment?: AttachmentKind; dedupeKey?: string }): Promise<WebhookResponse>;
  webhook(events: ChannelEvent[], secret?: string): Promise<WebhookResponse>;
  /** Выполняет задачи, чей срок пришёл (кроме `except`); часы не трогает. */
  runDue(except?: JobName): Promise<void>;
  /**
   * Выполняет все задачи, двигая часы к сроку следующей; задачи хода, ждущие окна тишины, — сдвигом часов на окно.
   * Таймеры сценария не трогает: их двигает `flow.tick()`.
   */
  drain(): Promise<void>;
  /** Тексты, которые бот отправил человеку. */
  textsTo(userId: string): string[];
  personOf(userId: string): Promise<typeof people.$inferSelect | undefined>;
  passagesOf(userId: string): Promise<Array<typeof passages.$inferSelect>>;
  inboundOf(userId: string): Promise<Array<typeof inboundMessages.$inferSelect>>;
  /** Запись в журнал расхода SDK «сейчас» по подменённым часам: так тест двигает дневной лимит и месячный бюджет. */
  spend(ownerId: string, usd: number, chatId?: string, source?: UsageSource): Promise<void>;
}

/**
 * Сбой провайдера, каким он доходит до хода после собственных быстрых повторов SDK: 503.
 * `x-should-retry: false` — чтобы SDK не повторял его ещё раз с настоящими паузами в тесте.
 */
export const providerOutage = () =>
  new APICallError({
    message: "Service Unavailable",
    url: "https://provider.test/v1/chat",
    requestBodyValues: {},
    statusCode: 503,
    responseHeaders: { "x-should-retry": "false" },
    isRetryable: false,
  });

/** Вопрос запасному судье сценария SDK: условия словами по последним репликам. */
export const isJudgeCall = (call: ScriptedCall) => call.system.startsWith("Ты судья");

export const DEFAULT_CONSULTANT_REPLY = "Понял. Расскажите подробнее.";

/** Сценарий по умолчанию: «готов» — завершить разговор, иначе обычный ответ. */
export function defaultConsultantReply(call: ScriptedCall): ScriptedReply {
  if (call.lastToolResult !== undefined) return {};
  if (call.lastUserText.toLowerCase().includes("готов"))
    return { toolCalls: [{ toolName: "finish_dialog", input: { goal: "Цель", stuckAt: "Застрял", chosenStep: "Созвон", outcome: "agreed" } }] };
  return { text: DEFAULT_CONSULTANT_REPLY };
}

export const BASE_SETTINGS: Partial<LeadMagnetSettings> = {
  instruction: "Ты консультант. Помоги человеку найти следующий шаг.",
  firstMessage: "Привет! Чем вы занимаетесь?",
  farewellMessage: "Спасибо за разговор! До встречи.",
  endCondition: "Человек выбрал следующий шаг",
};

let kitCounter = 0;

export async function createLiveDialogKit(database: TestDatabase, options: LiveDialogKitOptions = {}): Promise<LiveDialogKit> {
  const { db } = database;
  const clock = createFakeClock(options.start ?? new Date("2026-10-01T09:00:00Z"));
  const queue = new FakeQueue(clock);
  const channel = new FakeChannel();
  const chatStorage = options.chatStorage ?? createInMemoryChatStorage();
  const kitNumber = ++kitCounter;

  // Запасной судья сценария — та же подставная модель: его вопросы узнаются по инструкции и отвечаются `kit.judge`
  const scripted = createScriptedModel((call) => (isJudgeCall(call) ? { text: JSON.stringify({ met: kit.judge(call) }) } : kit.reply(call)));
  const modelChoice: ModelChoice = options.realModel?.choice ?? STUB_MODEL_CHOICE;
  const stubCatalog = extendCatalog(createAppCatalog(options.realJudge?.env ?? {}), {
    addProviders: [
      {
        id: STUB_MODEL_CHOICE.providerId,
        displayName: "Тестовая модель",
        apiKeyEnv: "STUB_MODEL_API_KEY",
        createLanguageModel: () => scripted.model,
        requestOptions: () => ({}),
      },
    ],
    addModels: [
      {
        id: STUB_MODEL_CHOICE.modelId,
        displayName: "Тестовая модель",
        contextWindowTokens: 100_000,
        acceptsImages: false,
        reasoning: { replayPastTurns: true },
        providerModelIds: { [STUB_MODEL_CHOICE.providerId]: "stub-v1" },
        pricing: {
          [STUB_MODEL_CHOICE.providerId]: {
            inputPerMillion: options.pricePerMillion ?? PRICE_PER_MILLION,
            outputPerMillion: options.pricePerMillion ?? PRICE_PER_MILLION,
          },
        },
      },
    ],
  });
  const catalog = options.realModel?.catalog ?? stubCatalog;

  const token = `fake-kit-${kitNumber}-${randomUUID().slice(0, 8)}`;
  const [botRow] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот ${kitNumber}`,
      externalId: `ext-${token}`,
      username: `kit_bot_${kitNumber}`,
      tokenEncrypted: KIT_CIPHER.encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  if (!botRow) throw new Error("Бот набора не создался");
  const bot: BotCredentials = {
    id: botRow.id,
    token,
    externalId: botRow.externalId,
    username: botRow.username,
    webhookSecret: botRow.webhookSecret,
  };

  const alertTexts: string[] = [];
  const alerts = createAlerts({ db, clock, notifier: { send: async (_chatId, text) => void alertTexts.push(text) } });
  const startWorker = () =>
    createLiveDialog({
      db,
      pool: database.pool,
      judgeFallback: options.realJudge?.choice ?? modelChoice,
      queue,
      clock,
      adapters: { telegram: channel },
      cipher: KIT_CIPHER,
      alerts,
      chatStorage,
      catalog,
      env: options.realModel?.env ?? { ...options.realJudge?.env, STUB_MODEL_API_KEY: "test" },
      modelChoice: () => modelChoice,
      // Часы подменены и стоят: окно пачки SDK проходит, когда их сдвигаем мы
      afterBurstRecorded: (window) => {
        kit.onBurstRecorded(window);
        recorded?.(window);
      },
    });
  let dialog = startWorker();

  const handlers: { [Name in JobName]?: (payload: JobPayloads[Name]) => Promise<void> } = {
    "inbound-route": ({ inboundMessageId }) => dialog.routeInbound(inboundMessageId),
    "inbound-turn": ({ passageId }) => dialog.runTurn(passageId),
    "outbound-send": ({ outboundMessageId }) => dialog.sendOutbound(outboundMessageId),
    "staff-reply": (reply) => dialog.noteStaffReply(reply),
    "chats-migrate": (input) => dialog.migrateChats(input),
    "budget-check": async () => void (await dialog.checkBudget()),
    "stuck-sweep": () => dialog.sweepStuck(),
    "purchase-congratulate": ({ passageId }) => dialog.congratulatePurchase(passageId),
    "payment-reminder": ({ passageId }) => dialog.remindPayment(passageId),
  };

  /** Задачи хода, чьё окно тишины ещё идёт: тест не сдвинул часы, как работник, они ждут в фоне. */
  const waitingWindows = new Set<Promise<void>>();
  let recorded: ((window: { quietMs: number }) => void) | undefined;

  /**
   * Задача хода записала сообщения и ждёт окна тишины. Сдвинул часы `onBurstRecorded` (по умолчанию) — ждём её до конца.
   * Не сдвинул — задача ждёт в фоне, как у работника, а тест пишет дальше; окно закроет `drain`.
   */
  async function runTurnJob(work: Promise<void>): Promise<void> {
    const window = new Promise<{ quietMs: number; at: number } | null>((resolve) => {
      recorded = ({ quietMs }) => resolve({ quietMs, at: clock.now().getTime() });
      void work.then(() => resolve(null), () => resolve(null));
    });
    const startedAt = clock.now().getTime();
    const waited = await window;
    recorded = undefined;
    if (!waited || waited.at - startedAt >= waited.quietMs) return work;
    const background = work.finally(() => waitingWindows.delete(background));
    waitingWindows.add(background);
  }

  async function runDue(except?: JobName): Promise<void> {
    for (let job = queue.takeDue(except); job; job = queue.takeDue(except)) {
      const handler = handlers[job.name] as ((payload: unknown) => Promise<void>) | undefined;
      if (!handler) throw new Error(`Нет обработчика задачи ${job.name}`);
      if (job.name === "inbound-turn") await runTurnJob(handler(job.payload));
      else await handler(job.payload);
      // Фоновая работа сценария (судья после хода, onTransition, onFinish) и доставка ответов на брошенные пачки — до
      // следующей задачи: тест детерминирован
      await dialog.flow.settled();
      await dialog.settled();
    }
  }

  let eventCounter = 0;

  const kit: LiveDialogKit = {
    db,
    channel,
    clock,
    queue,
    chatStorage,
    dialog,
    alerts,
    alertTexts,
    bot,
    calls: scripted.calls,
    reply: defaultConsultantReply,
    judge: () => [],
    onBurstRecorded: ({ quietMs }) => clock.advance(quietMs),
    async restartWorker() {
      await dialog.flush({ waitForAnswersMs: 0 });
      dialog = startWorker();
      kit.dialog = dialog;
      await dialog.recoverAnswers();
    },
    consultantCalls: () => scripted.calls.filter((call) => !isJudgeCall(call)),
    async firstMessages() {
      const rows = await outboundOf(kit);
      return rows
        .filter((row) => row.kind === "outreach" && row.status === "sent")
        .map((row) => ({ text: row.text, at: row.sentAt! }))
        .sort((a, b) => a.at.getTime() - b.at.getTime());
    },

    async publish(settings = {}, adjustFlow = (flow) => flow) {
      let lead;
      if (options.leadMagnetId) {
        const initial = newLeadMagnetSettings(settings.name ?? "Fixture");
        const [row] = await db.insert(leadMagnets).values({ id: options.leadMagnetId, draft: initial }).returning();
        const [version] = await db.insert(leadMagnetVersions).values({ leadMagnetId: row!.id, settings: initial, source: "manual" }).returning();
        lead = { ...row!, draftVersionId: version!.id };
      } else lead = await createLeadMagnet(db, { name: settings.name ?? `Лидмагнит ${randomUUID().slice(0, 6)}` });
      const merged = { ...lead.draft, ...modelChoice, ...BASE_SETTINGS, ...settings };
      // Тесты задают лидмагнит старыми полями (этапы, программа) — сценарий из них, как при переводе настроек
      const flow = adjustFlow(settings.flow ?? leadMagnetToFlow(merged, await getFields(db, merged.fieldIds)));
      await saveDraft(db, lead.id, { ...merged, flow }, "manual");
      await attachBot(db, { leadMagnetId: lead.id, botId: bot.id });
      const published = await publishLeadMagnet(db, lead.id);
      return { leadMagnetId: lead.id, ...published };
    },

    send(userId, text, extra = {}) {
      return kit.webhook([
        {
          type: "message",
          dedupeKey: extra.dedupeKey ?? `telegram:${bot.id}:${++eventCounter}`,
          userId,
          userName: `Человек ${userId}`,
          text,
          ...(extra.attachment && { attachment: extra.attachment }),
          ...(extra.startCode && { startCode: extra.startCode }),
        },
      ]);
    },

    webhook(events, secret) {
      return dialog.acceptWebhook({ channel: "telegram", botId: bot.id, request: channel.webhookRequest(bot, events, secret) });
    },

    runDue,

    async drain() {
      for (let guard = 0; guard < 1000; guard++) {
        await dialog.settled();
        await runDue();
        if (waitingWindows.size > 0) {
          // Человек замолчал: окна тишины проходят, ход на пачку начинается
          clock.advance(BURST_QUIET_MS);
          await dialog.tickBursts();
          await Promise.all(waitingWindows);
          await dialog.flow.settled();
          continue;
        }
        const next = queue.nextRunAt();
        if (next === undefined) return;
        clock.set(new Date(Math.max(next, clock.now().getTime())));
      }
      throw new Error("Очередь не опустела за 1000 шагов");
    },

    textsTo(userId) {
      return channel.messagesTo(userId).map((entry) => entry.message.text);
    },

    async personOf(userId) {
      const rows = await db.select().from(people).where(eq(people.externalUserId, userId));
      return rows.find((row) => row.botId === bot.id);
    },

    async passagesOf(userId) {
      const person = await kit.personOf(userId);
      if (!person) return [];
      return db.select().from(passages).where(eq(passages.personId, person.id)).orderBy(passages.startedAt);
    },

    async inboundOf(userId) {
      const rows = await db.select().from(inboundMessages).where(eq(inboundMessages.externalUserId, userId)).orderBy(inboundMessages.receivedAt);
      return rows.filter((row) => row.botId === bot.id);
    },

    async spend(ownerId, usd, chatId = `spend-${randomUUID()}`, source = "answer") {
      await chatStorage.insertUsageRecord({
        id: randomUUID(),
        ownerId,
        chatId,
        messageId: null,
        source,
        ...STUB_MODEL_CHOICE,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costUsd: usd,
        createdAt: clock.now().toISOString(),
      });
    },
  };
  return kit;
}

/** Исходящие сообщения бота набора. */
export async function outboundOf(kit: LiveDialogKit) {
  return kit.db.select().from(outboundMessages).where(eq(outboundMessages.botId, kit.bot.id));
}
