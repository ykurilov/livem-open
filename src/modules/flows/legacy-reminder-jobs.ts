import { PgBoss } from "pg-boss";

/**
 * Задача старых напоминаний (до «Сценариев», снята в S6). Её задачи, поставленные до выкладки, остались в очереди
 * pg-boss, а обработчика больше нет: касания ведёт сценарий SDK. Перенос идущих чатов их отменяет.
 */
export const LEGACY_REMINDER_JOB = "reminder";

const UNFINISHED_STATES = new Set(["created", "retry", "active"]);

/** Сколько старых задач ждали и сколько из них отменено. */
export interface LegacyReminderJobs {
  waiting: number;
  cancelled: number;
}

export type LegacyJobsQueue = Pick<PgBoss, "getQueue" | "findJobs" | "cancel">;

/**
 * Отменить незаконченные задачи `reminder`: они помечаются `cancelled` и остаются в истории очереди, пока её не
 * почистит сам pg-boss. Без `apply` — только посчитать. Очереди нет — ничего не делает. Повторный запуск ничего не меняет.
 */
export async function cancelLegacyReminderJobs(queue: LegacyJobsQueue, options: { apply: boolean }): Promise<LegacyReminderJobs> {
  if (!(await queue.getQueue(LEGACY_REMINDER_JOB))) return { waiting: 0, cancelled: 0 };
  const unfinished = async () => (await queue.findJobs(LEGACY_REMINDER_JOB)).filter((job) => UNFINISHED_STATES.has(job.state));
  const waiting = await unfinished();
  if (!options.apply || waiting.length === 0) return { waiting: waiting.length, cancelled: 0 };
  await queue.cancel(LEGACY_REMINDER_JOB, waiting.map((job) => job.id));
  return { waiting: waiting.length, cancelled: waiting.length - (await unfinished()).length };
}

export function formatLegacyReminderReport(result: LegacyReminderJobs, options: { apply: boolean }): string {
  return options.apply
    ? `Старые задачи напоминаний (reminder): ждали ${result.waiting}, отменено ${result.cancelled}.`
    : `Старые задачи напоминаний (reminder): ждут ${result.waiting}, отменю их. Режим «посмотреть», ничего не записано. Применить: --apply`;
}

/** Очередь pg-boss приложения для скрипта: без расписания и присмотра работника. */
export async function openJobsQueue(connectionString: string): Promise<{ queue: LegacyJobsQueue; close(): Promise<void> }> {
  const boss = new PgBoss({ connectionString, schema: "pgboss", supervise: false, schedule: false, max: 1 });
  boss.on("error", (error) => console.error("Очередь:", error));
  await boss.start();
  return { queue: boss, close: () => boss.stop({ graceful: false }) };
}
