import { PgBoss } from "pg-boss";
import { requireEnv } from "./env";
import { sharedPerProcess } from "./process-shared";

/** Какие данные несёт каждая задача. Новые задачи этапов добавляются сюда. */
export interface JobPayloads {
  "inbound-route": { inboundMessageId: string };
  "inbound-turn": { passageId: string };
  "outbound-send": { outboundMessageId: string };
  /** Эксперт ответил человеку из «Входящих»: консультант молчит, пока эксперт ведёт разговор. */
  "staff-reply": { personId: string };
  /** Эксперт перевёл идущие разговоры на новую версию: сценарий SDK переводит их чаты (наши данные уже переведены). */
  "chats-migrate": { leadMagnetId: string; toVersionId: string };
  "mailing-start": { mailingId: string };
  "mailing-batch": { mailingId: string };
  "budget-check": Record<string, never>;
  "bot-health": Record<string, never>;
  "stuck-sweep": Record<string, never>;
  "agent-log-cleanup": Record<string, never>;
  /** Пришла оплата продукта: Василий поздравляет первым, один раз. */
  "purchase-congratulate": { passageId: string };
  /** Обещал оплатить или оформил заказ: назавтра одно напоминание, если оплаты нет. */
  "payment-reminder": { passageId: string };
}

export type JobName = keyof JobPayloads;

export const JOB_NAMES: JobName[] = [
  "inbound-route",
  "inbound-turn",
  "outbound-send",
  "staff-reply",
  "chats-migrate",
  "mailing-start",
  "mailing-batch",
  "budget-check",
  "bot-health",
  "stuck-sweep",
  "agent-log-cleanup",
  "purchase-congratulate",
  "payment-reminder",
];

export interface EnqueueOptions {
  /** Не раньше, чем через столько секунд. */
  delaySeconds?: number;
  /** Задача с тем же ключом, пока она ждёт, не добавляется второй раз. */
  singletonKey?: string;
}

/** Только то, что нужно коду, который ставит задачи. Тесты подменяют его записью в память. */
export interface JobEnqueuer {
  enqueue<Name extends JobName>(name: Name, payload: JobPayloads[Name], options?: EnqueueOptions): Promise<void>;
}

export interface WorkOptions {
  concurrency?: number;
}

export interface AppQueue extends JobEnqueuer {
  start(): Promise<void>;
  work<Name extends JobName>(
    name: Name,
    handler: (payload: JobPayloads[Name]) => Promise<void>,
    options?: WorkOptions,
  ): Promise<void>;
  /** Повторять задачу по расписанию (cron, время UTC). Вызов с тем же именем заменяет прежнее расписание. Работает только у работника. */
  schedule(name: JobName, cron: string): Promise<void>;
  /** Очередь отвечает: схема на месте и база принимает запросы. */
  ping(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface QueueConfig {
  connectionString: string;
  /** Работник чистит очередь и ведёт расписание; веб только ставит задачи. */
  role: "web" | "worker";
  pollingIntervalSeconds?: number;
}

// `short`: пока в очереди ждёт задача с этим ключом, вторая с тем же ключом не добавляется
// (так склеиваются сообщения одного человека в один ход консультанта)
const QUEUE_POLICIES: Partial<Record<JobName, "short">> = { "inbound-turn": "short" };

const RETRY_LIMIT = 5;
const RETRY_DELAY_SECONDS = 10;

export function createQueue(config: QueueConfig): AppQueue {
  const boss = new PgBoss({
    connectionString: config.connectionString,
    schema: "pgboss",
    supervise: config.role === "worker",
    schedule: config.role === "worker",
    max: 5,
  });
  boss.on("error", (error) => console.error("Очередь:", error));
  let started = false;

  return {
    async start() {
      if (started) return;
      try {
        await boss.start();
        for (const name of JOB_NAMES) {
          await boss.createQueue(name, {
            retryLimit: RETRY_LIMIT,
            retryDelay: RETRY_DELAY_SECONDS,
            retryBackoff: true,
            ...(QUEUE_POLICIES[name] && { policy: QUEUE_POLICIES[name] }),
          });
        }
      } catch (error) {
        // Неудачный старт не оставляет открытых соединений и таймеров: следующая попытка начнёт с чистого листа
        await boss.stop({ graceful: false }).catch(() => undefined);
        throw error;
      }
      started = true;
    },

    async enqueue(name, payload, options = {}) {
      await boss.send(name, payload, {
        ...(options.delaySeconds !== undefined && { startAfter: options.delaySeconds }),
        ...(options.singletonKey !== undefined && { singletonKey: options.singletonKey }),
      });
    },

    async work(name, handler, options = {}) {
      await boss.work<JobPayloads[typeof name]>(
        name,
        { localConcurrency: options.concurrency ?? 1, pollingIntervalSeconds: config.pollingIntervalSeconds ?? 2 },
        async (jobs) => {
          for (const job of jobs) await handler(job.data);
        },
      );
    },

    async schedule(name, cron) {
      await boss.schedule(name, cron);
    },

    async ping() {
      if (!started) return false;
      try {
        await boss.getQueues(["outbound-send"]);
        return true;
      } catch {
        return false;
      }
    },

    async stop() {
      if (!started) return;
      started = false;
      // Дольше срока ответа консультанта при остановке работника: его задача успеет поставить повтор хода
      await boss.stop({ graceful: true, timeout: 30_000 });
    },
  };
}

/** Одна очередь на процесс веб-приложения; не стартовала (база ещё не поднялась) — следующий вызов пробует снова. */
export function getWebQueue(): Promise<AppQueue> {
  return sharedPerProcess("livemWebQueue", async () => {
    const queue = createQueue({ connectionString: requireEnv("DATABASE_URL"), role: "web" });
    await queue.start();
    return queue;
  });
}
