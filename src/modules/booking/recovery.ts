import { and, eq, gt, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm";
import { outboundMessages } from "../channels/schema";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { undeliveredMessageJoin, undeliveredText } from "./bookings";
import { CALL_REMINDER_MINUTES, queueCallNotices, REMINDER_TOO_LATE_MINUTES } from "./notices";
import { callBookings, callNotices } from "./schema";

const MINUTE_MS = 60_000;
/** Старше этого не доводим: уведомление или тревога через сутки уже ни к чему. */
const RECOVERY_WINDOW_MS = 24 * 60 * MINUTE_MS;
const RECOVERY_BATCH = 200;

/**
 * Часть задачи `stuck-sweep`: последствия записи на созвон, которые потерялись (очередь лежала, работник упал).
 * Уведомление записано, а задачи нет; время напоминания прошло, а напоминания не было; напоминание или сообщение об отмене
 * не дошло — эксперту. Сообщение об отмене без задачи доводит подмётчик исходящих.
 * Отправка уведомления и напоминания идемпотентна: лишняя задача ничего не задвоит. Возвращает, сколько поставлено.
 */
export async function recoverCallBookingWork(deps: { db: Database; queue: JobEnqueuer; clock: Clock }, overdueBefore: Date): Promise<number> {
  const now = deps.clock.now();
  const recoverySince = new Date(now.getTime() - RECOVERY_WINDOW_MS);

  const notices = await deps.db
    .select({ id: callNotices.id })
    .from(callNotices)
    .where(and(eq(callNotices.status, "queued"), lt(callNotices.createdAt, overdueBefore), gt(callNotices.createdAt, recoverySince)))
    .limit(RECOVERY_BATCH);
  for (const { id } of notices) await deps.queue.enqueue("call-notice-send", { noticeId: id });

  // Записи, сделанные слишком близко к созвону, напоминания и не ждали
  const reminders = await deps.db
    .select({ id: callBookings.id })
    .from(callBookings)
    .where(
      and(
        eq(callBookings.status, "booked"),
        isNull(callBookings.testChatId),
        isNotNull(callBookings.personId),
        isNull(callBookings.reminderSentAt),
        gt(callBookings.startsAt, now),
        lt(callBookings.startsAt, new Date(overdueBefore.getTime() + CALL_REMINDER_MINUTES * MINUTE_MS)),
        sql`${callBookings.createdAt} <= ${callBookings.startsAt} - make_interval(mins => ${REMINDER_TOO_LATE_MINUTES})`,
      ),
    )
    .limit(RECOVERY_BATCH);
  for (const { id } of reminders) await deps.queue.enqueue("call-reminder", { bookingId: id });

  const alerts = (await alertUndelivered(deps, recoverySince, "reminder")) + (await alertUndelivered(deps, recoverySince, "cancel_message"));

  return notices.length + reminders.length + alerts;
}

/**
 * Напоминание или сообщение об отмене экспертом окончательно не ушло (мессенджер не даёт писать первым, бот остановлен) —
 * эксперту в бота, один раз. Повтора нет: так же, как у других сообщений первым.
 */
async function alertUndelivered(deps: { db: Database; queue: JobEnqueuer; clock: Clock }, since: Date, what: "reminder" | "cancel_message"): Promise<number> {
  const kind = what === "reminder" ? "reminder_failed" : "cancel_message_failed";
  const relevant =
    what === "reminder"
      ? and(eq(callBookings.status, "booked"), gt(callBookings.reminderSentAt, since))
      : and(eq(callBookings.status, "cancelled"), eq(callBookings.cancelledBy, "expert"), gt(callBookings.cancelledAt, since));
  const undelivered = await deps.db
    .select({ booking: callBookings, status: outboundMessages.status, error: outboundMessages.error })
    .from(callBookings)
    .innerJoin(outboundMessages, undeliveredMessageJoin(outboundMessages, what === "reminder" ? "call-reminder:" : "call-cancelled:"))
    .where(
      and(
        relevant,
        notExists(
          deps.db
            .select({ id: callNotices.id })
            .from(callNotices)
            .where(and(eq(callNotices.bookingId, callBookings.id), eq(callNotices.kind, kind))),
        ),
      ),
    )
    .limit(RECOVERY_BATCH);
  let alerts = 0;
  for (const { booking, status, error } of undelivered) {
    if (status !== "failed" && status !== "blocked") continue;
    alerts += await queueCallNotices(deps, { kind, booking, reason: undeliveredText(status, error) });
  }
  return alerts;
}
