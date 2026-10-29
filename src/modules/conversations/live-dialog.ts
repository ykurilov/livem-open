import type { ChatStorage, ModelCatalog, ModelChoice, RunningAnswerRegistry } from "@ykurilov/agent-chat-core";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import type { AlertService } from "../alerts";
import { reportSendFailure, sendOutbound, type ChannelAdapters, type OutboundDependencies, type RateLimiter, type WebhookRequest } from "../channels";
import { createHeadlessConsultant } from "../consultant/headless-turn";
import { applyChatMigration } from "../flows/chat-migration";
import { createFirstMessageDelivery, sendTargetOf } from "../flows/delivery";
import { createLeadMagnetFlow, type LeadMagnetFlow } from "../flows/runtime";
import type { LeadMagnetSettings } from "../lead-magnets";
import { markPersonBlocked } from "../people";
import type { Clock } from "../platform/clock";
import type { TokenCipher } from "../platform/crypto";
import type { Database } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import {
  checkBudget,
  createDailyLimits,
  createModelFailureTracker,
  providerOutageAlerts,
  readBudgetStatus,
  type BudgetStatus,
} from "../spending";
import { congratulatePurchase, remindPayment } from "../purchases/reactions";
import { endActivePassages } from "./passage-end";
import { createPassageConversationStore } from "./passage-store";
import { routeInboundMessage } from "./router";
import { passages } from "./schema";
import { sweepStuckWork } from "./sweep";
import { releaseBurstTurn, reserveBurstTurn, runPassageTurn, settleUnattendedTurn, type TurnSpending } from "./turn";
import { acceptWebhook, type WebhookResponse } from "./webhook";

export type { WebhookResponse };

export interface LiveDialogDependencies {
  db: Database;
  /** Пул той же базы: хранилище сценариев SDK. */
  pool: Pool;
  queue: JobEnqueuer;
  clock: Clock;
  adapters: ChannelAdapters;
  cipher: TokenCipher;
  alerts: AlertService;
  chatStorage: ChatStorage;
  catalog: ModelCatalog;
  env?: Record<string, string | undefined>;
  /** Реестр идущих ответов процесса; не задан — свой. */
  registry?: RunningAnswerRegistry;
  /** Модель консультанта по настройкам снимка. */
  modelChoice(settings: LeadMagnetSettings): ModelChoice;
  rateLimiter?: RateLimiter;
  /** Запасной судья сценария; не задан — DeepSeek 4.1 Flash. Тесты дают подставную модель. */
  judgeFallback?: ModelChoice;
  /** Подменённые часы: сдвинуть на окно пачки SDK (`HeadlessConsultantOptions.afterBurstRecorded`). */
  afterBurstRecorded?: (window: { quietMs: number }) => void;
}

/** Живой диалог в мессенджере: приём вебхука и обработчики задач работника. */
export interface LiveDialog {
  /** Сценарии разговоров: таймеры запускает работник (`flow.start()`, при остановке `flow.stop()`). */
  flow: LeadMagnetFlow;
  /** Вебхук: проверка секрета, запись входящих и задача `inbound-route`. Ни модели, ни мессенджера. */
  acceptWebhook(input: { channel: string; botId: string; request: WebhookRequest }): Promise<WebhookResponse>;
  /** Задача `inbound-route`. */
  routeInbound(inboundMessageId: string): Promise<void>;
  /** Задача `inbound-turn`. */
  runTurn(passageId: string): Promise<void>;
  /** Задача `outbound-send`. */
  sendOutbound(outboundMessageId: string): Promise<void>;
  /** Задача `stuck-sweep`: входящие и исходящие, которые записаны, но остались без задачи. */
  sweepStuck(): Promise<void>;
  /** Задача `budget-check`: пороги месячного бюджета, тревоги, возобновление остановленных. */
  checkBudget(): Promise<BudgetStatus>;
  /**
   * Задача `staff-reply`: эксперт ответил из «Входящих» посреди живого разговора — консультант молчит, пока эксперт
   * ведёт разговор (пауза сценария до 2 часов тишины эксперта). Сам ответ эксперта ложится в историю консультанта
   * следующим ходом репликой сотрудника (`appendStaffMessage`): так его видят карточка человека и кэш модели.
   */
  noteStaffReply(input: { personId: string }): Promise<void>;
  /** Задача `chats-migrate`: перевод идущих разговоров на новую версию в сценарии SDK, после записи в наших данных. */
  migrateChats(input: { leadMagnetId: string; toVersionId: string }): Promise<void>;
  /**
   * Запуск работника, до задач: прерванные ответы помечаются, брошенные прошлым работником пачки отвечает консультант
   * версии их разговора, ответ уходит через наш бот. Дальше обход идёт сам.
   */
  recoverAnswers(): Promise<void>;
  /** Обход пачек сейчас — по подменённым часам (тесты, eval). */
  tickBursts(): Promise<void>;
  /** Ответы на брошенные пачки, начатые к этому моменту, доставлены (тесты, eval). */
  settled(): Promise<void>;
  /** Остановка работника: ходы консультанта дорабатывают до срока, не успевшие повторит новый работник. */
  flush(options: { waitForAnswersMs: number }): Promise<void>;
  /** Задача `purchase-congratulate`: пришла оплата — Василий поздравляет первым, один раз. */
  congratulatePurchase(passageId: string): Promise<void>;
  /** Задача `payment-reminder`: одно напоминание об оплате, если её так и нет. */
  remindPayment(passageId: string): Promise<void>;
}

export function createLiveDialog(deps: LiveDialogDependencies): LiveDialog {
  const { db, clock } = deps;
  const limits = createDailyLimits({ db, chatStorage: deps.chatStorage, catalog: deps.catalog, clock });
  const isEmergencyStopped = async () => (await readBudgetStatus(deps)).emergencyStopped;
  const botHealth = { db, queue: deps.queue, alerts: deps.alerts, adapters: deps.adapters, cipher: deps.cipher };
  const flow = createLeadMagnetFlow({
    db,
    pool: deps.pool,
    clock,
    ...(deps.env && { env: deps.env }),
    ...(deps.judgeFallback && { judgeFallback: deps.judgeFallback }),
    // Сообщения первым — сразу через бот человека; повторы и исходы ведёт сценарий
    deliver: createFirstMessageDelivery({
      db,
      clock,
      adapters: deps.adapters,
      cipher: deps.cipher,
      chatStorage: deps.chatStorage,
      ...(deps.rateLimiter && { rateLimiter: deps.rateLimiter }),
      onPermanentFailure: (botId, error) => reportSendFailure(botHealth, botId, error),
      endFlow: (input) => flow.end(input),
      logError: (message) => console.error(message),
    }),
    isEmergencyStopped,
  });
  const consultant = createHeadlessConsultant({
    db,
    chatStorage: deps.chatStorage,
    catalog: deps.catalog,
    ...(deps.env && { env: deps.env }),
    ...(deps.registry && { registry: deps.registry }),
    store: createPassageConversationStore(db, clock, deps.queue),
    modelChoice: deps.modelChoice,
    limits,
    flow,
    now: () => clock.now(),
    ...(deps.afterBurstRecorded && { afterBurstRecorded: deps.afterBurstRecorded }),
    onBurstTurn: (input) => reserveBurstTurn({ db }, input),
    onBurstTurnRefused: (input) => releaseBurstTurn({ db }, input),
    onUnattendedAnswer: (input) => settleUnattendedTurn(turnDeps, input),
    // Пустой счёт или плохой ключ провайдера: ходы идут через запасной, но чинить это эксперту
    onLogLine: providerOutageAlerts(deps),
  });
  // Таймеры сценария будят чат той же службой, что ведёт его ход
  flow.attachPorts((chat) => consultant.portFor(chat));
  const spending: TurnSpending = {
    isEmergencyStopped,
    checkBudget: () => checkBudget(deps),
    modelFailures: createModelFailureTracker(deps),
  };
  const turnDeps = { ...deps, consultant, flow, spending };
  const outbound: OutboundDependencies = {
    db,
    queue: deps.queue,
    clock,
    ...(deps.rateLimiter && { rateLimiter: deps.rateLimiter }),
    resolveTarget: (message) => sendTargetOf(deps, db, message),
    async onBlocked(message) {
      const at = clock.now();
      const active = await activeChatOf(message.personId);
      await db.transaction(async (tx) => {
        await markPersonBlocked(tx, message.personId, at);
        await endActivePassages(tx, eq(passages.personId, message.personId), "blocked", at);
      });
      if (active) await flow.end({ ownerId: message.personId, chatId: active, reason: "blocked" });
    },
    onPermanentFailure: (message, error) => reportSendFailure(botHealth, message.botId, error),
  };

  async function activeChatOf(personId: string): Promise<string | null> {
    const [active] = await db
      .select({ chatId: passages.chatId })
      .from(passages)
      .where(and(eq(passages.personId, personId), eq(passages.status, "active")));
    return active?.chatId ?? null;
  }

  return {
    flow,
    acceptWebhook: (input) => acceptWebhook(deps, input),
    routeInbound: (id) => routeInboundMessage({ ...deps, consultant, flow }, id),
    runTurn: (passageId) => runPassageTurn(turnDeps, passageId),
    sendOutbound: (id) => sendOutbound(outbound, id),
    sweepStuck: () => sweepStuckWork(deps),
    checkBudget: () => checkBudget(deps),
    async migrateChats(input) {
      await applyChatMigration({ db, flow }, input);
    },
    async noteStaffReply({ personId }) {
      const chatId = await activeChatOf(personId);
      if (chatId) await flow.noteStaffReply({ ownerId: personId, chatId });
    },
    recoverAnswers: () => consultant.recoverAnswers(),
    tickBursts: () => consultant.tickBursts(),
    settled: () => consultant.settled(),
    flush: (options) => consultant.flush(options),
    congratulatePurchase: (passageId) => congratulatePurchase({ db, queue: deps.queue, clock, writer: consultant }, passageId),
    remindPayment: (passageId) => remindPayment({ db, queue: deps.queue, clock, writer: consultant }, passageId),
  };
}
