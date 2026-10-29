import { BOT_HEALTH_CRON, botWebhookUrl, checkAllBots, createChannelAdapters, createRateLimiter } from "@/modules/channels";
import { createAgentLogRecorder, deleteOldAgentLog, withAgentLog } from "@/modules/agent-log";
import { createAlertsFromEnv } from "@/modules/alerts";
import { createLiveDialog, STUCK_SWEEP_CRON } from "@/modules/conversations";
import { createMailingJobs } from "@/modules/mailings";
import { resumeOutreachAwaitingRepair } from "@/modules/flows/delivery-repair";
import { loadAppModels } from "@/modules/platform/app-models";
import { getChatStorage, getRunningAnswerRegistry } from "@/modules/platform/chat-storage";
import { systemClock } from "@/modules/platform/clock";
import { createTokenCipher } from "@/modules/platform/crypto";
import type { DatabaseConnection } from "@/modules/platform/db";
import { optionalEnv, requireEnv } from "@/modules/platform/env";
import type { AppQueue } from "@/modules/platform/queue";
import { BUDGET_CHECK_CRON } from "@/modules/spending";

/** Чистка журнала агентов: раз в сутки ночью (UTC). */
const AGENT_LOG_CLEANUP_CRON = "17 0 * * *";

export interface JobHandlerContext {
  queue: AppQueue;
  connection: DatabaseConnection;
}

/** Сколько задач каждой очереди живого диалога работник ведёт одновременно. */
const LIVE_DIALOG_CONCURRENCY = 5;
/**
 * Задача хода ждёт окна тишины пачки и ответа модели, почти не занимая базу: у каждого пишущего человека по задаче на
 * сообщение. Пять таких задач заняли бы работника двумя-тремя людьми.
 */
const TURN_CONCURRENCY = 30;

/** Что работнику сделать при остановке, до закрытия базы. */
export interface JobHandlers {
  /** Ходы консультанта: идущие дорабатывают до срока, не успевшие останавливаются и повторятся. */
  flush(options: { waitForAnswersMs: number }): Promise<void>;
  /** Таймеры сценариев: новые не берутся, идущие и фоновая работа (судья, `onFinish`) дорабатывают. */
  stopFlows(): Promise<void>;
}

/** Здесь каждый этап подключает обработчики своих очередей (`queue.work("inbound-turn", …)` и так далее). */
export async function registerJobHandlers({ queue, connection }: JobHandlerContext): Promise<JobHandlers> {
  const { db } = connection;
  const adapters = createChannelAdapters();
  const cipher = createTokenCipher(requireEnv("BOT_TOKEN_KEY"));
  const alerts = createAlertsFromEnv(db);

  const addresses = { publicBaseUrl: optionalEnv("PUBLIC_BASE_URL") ?? "", telegramWebhookBaseUrl: optionalEnv("TELEGRAM_WEBHOOK_BASE_URL") };
  const models = await loadAppModels();
  // Ходы консультанта в мессенджере пишутся в журнал лидмагнита (вкладка «Лог»)
  const catalog = withAgentLog(models.catalog, createAgentLogRecorder(db, process.env));
  const chatStorage = await getChatStorage(requireEnv("DATABASE_URL"));
  const registry = getRunningAnswerRegistry();

  const dialog = createLiveDialog({
    db,
    pool: connection.pool,
    queue,
    clock: systemClock,
    adapters,
    cipher,
    alerts,
    chatStorage,
    catalog,
    env: models.env,
    registry,
    modelChoice: (settings) => models.consultantChoice(settings),
    rateLimiter: createRateLimiter({ now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }),
  });
  await queue.work("bot-health", async () => {
    await checkAllBots({ db, queue, alerts, adapters, cipher, webhookUrl: addresses.publicBaseUrl ? (channel, botId) => botWebhookUrl(addresses, channel, botId) : undefined });
    await resumeOutreachAwaitingRepair({ db, flow: dialog.flow, logError: console.error });
  });
  await queue.schedule("bot-health", BOT_HEALTH_CRON);
  // Ответы, брошенные упавшим работником, помечаются прерванными: повтор хода начнёт ответ заново. Пачки, брошенные
  // посреди окна тишины, отвечает консультант версии их разговора — до задач, чтобы ответ не опередила задача хода
  await dialog.recoverAnswers();
  const concurrency = { concurrency: LIVE_DIALOG_CONCURRENCY };
  await queue.work("inbound-route", ({ inboundMessageId }) => dialog.routeInbound(inboundMessageId), concurrency);
  await queue.work("inbound-turn", ({ passageId }) => dialog.runTurn(passageId), { concurrency: TURN_CONCURRENCY });
  await queue.work("outbound-send", ({ outboundMessageId }) => dialog.sendOutbound(outboundMessageId), concurrency);
  await queue.work("staff-reply", (reply) => dialog.noteStaffReply(reply), concurrency);
  await queue.work("chats-migrate", (input) => dialog.migrateChats(input));
  // Оплата продукта (GetCourse): поздравление и одно напоминание — ходом консультанта, через наш бот
  await queue.work("purchase-congratulate", ({ passageId }) => dialog.congratulatePurchase(passageId), concurrency);
  await queue.work("payment-reminder", ({ passageId }) => dialog.remindPayment(passageId), concurrency);
  // Таймеры сценариев: переходы по дням, «срок вышел», «не завершил», касания через наши боты
  dialog.flow.start();
  const mailing = createMailingJobs({ db, queue, clock: systemClock, adapters, alerts });
  await queue.work("stuck-sweep", async () => {
    await dialog.sweepStuck();
    await mailing.sweep();
  });
  await queue.schedule("stuck-sweep", STUCK_SWEEP_CRON);
  await queue.work("budget-check", async () => void (await dialog.checkBudget()));
  await queue.schedule("budget-check", BUDGET_CHECK_CRON);

  await queue.work("agent-log-cleanup", async () => void (await deleteOldAgentLog(db, new Date())));
  await queue.schedule("agent-log-cleanup", AGENT_LOG_CLEANUP_CRON);

  await queue.work("mailing-start", ({ mailingId }) => mailing.start(mailingId));
  await queue.work("mailing-batch", ({ mailingId }) => mailing.batch(mailingId));

  return { flush: (options) => dialog.flush(options), stopFlows: () => dialog.flow.stop() };
}
