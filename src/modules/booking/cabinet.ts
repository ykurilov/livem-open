import { eq, inArray } from "drizzle-orm";
import { recordOutbound, scheduleOutboundSend } from "../channels/outbound";
import type { Clock } from "../platform/clock";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { people } from "../people/schema";
import { callCancelMessageKey, cancelBookingByExpert, listCallBookings } from "./bookings";
import { listCallWindows, readCallCalendar } from "./calendar";
import { callCancelledByExpertText, queueCallNotices } from "./notices";
import type { CallBookingRow } from "./schema";
import { slotLabel } from "./slots";
import { callWeek, weekStartOf, type CallWeek } from "./week";
import { localDate } from "../program/calendar";

/** Запись, которая окажется вне окон после правки календаря: эксперт видит её до согласия. */
export interface OutsideBooking {
  id: string;
  label: string;
  personName: string | null;
}

export async function describeOutsideBookings(db: DatabaseExecutor, rows: readonly CallBookingRow[]): Promise<OutsideBooking[]> {
  if (rows.length === 0) return [];
  const { timeZone } = await readCallCalendar(db);
  const ids = rows.map((row) => row.personId).filter((id): id is string => id !== null);
  const names = ids.length ? await db.select({ id: people.id, name: people.displayName }).from(people).where(inArray(people.id, ids)) : [];
  return rows.map((row) => ({ id: row.id, label: slotLabel(row, timeZone), personName: names.find((one) => one.id === row.personId)?.name ?? null }));
}

/** Вкладка «Календарь»: неделя `week` (любой её день) или текущая по часам эксперта. */
export async function readCallCalendarWeek(db: DatabaseExecutor, input: { now: Date; week?: string }): Promise<CallWeek & { timeZone: string; callMinutes: number }> {
  const calendar = await readCallCalendar(db);
  const weekStart = weekStartOf(input.week && /^\d{4}-\d{2}-\d{2}$/.test(input.week) ? input.week : localDate(input.now, calendar.timeZone));
  const [windows, bookings] = await Promise.all([listCallWindows(db), listCallBookings(db, { now: input.now, pastDays: 400 })]);
  return { ...calendar, ...callWeek({ weekStart, timeZone: calendar.timeZone, now: input.now, windows, bookings }) };
}

/** Сообщить ли человеку об отмене: своими словами эксперта или, если их нет, простым текстом с предложением другого времени. */
export interface CancelMessage {
  tellPerson: boolean;
  text?: string;
  /** Имя эксперта: консультант видит сообщение его репликой. */
  staffName?: string;
}

const logLater = (what: string) => (error: unknown) => console.error(`${what}:`, error instanceof Error ? error.message : error);

/**
 * Эксперт отменяет запись в «Записях»: статус, сообщение человеку туда, где он разговаривает, и уведомление в бот эксперта.
 * Сообщение — репликой эксперта (как ответ из «Входящих», но без паузы консультанта): консультант увидит его в следующем
 * ходе и может записать заново. Отмена и сообщение пишутся вместе; задачи не встали — их доведут подмётчики. Уже не действует — `false`.
 */
export async function cancelCallByExpert(deps: { db: Database; queue: JobEnqueuer; clock: Clock }, bookingId: string, message: CancelMessage): Promise<boolean> {
  const cancelled = await deps.db.transaction(async (tx) => {
    const booking = await cancelBookingByExpert(tx, bookingId, deps.clock.now());
    if (!booking) return null;
    const [person] = message.tellPerson && booking.personId ? await tx.select({ id: people.id, botId: people.botId }).from(people).where(eq(people.id, booking.personId)) : [];
    if (!person) return { booking, messageId: null };
    const text = message.text?.trim() || callCancelledByExpertText(booking, (await readCallCalendar(tx)).timeZone);
    const recorded = await recordOutbound(tx, deps.clock, {
      botId: person.botId,
      personId: person.id,
      kind: "manual_reply",
      text,
      ...(message.staffName?.trim() && { staffName: message.staffName.trim() }),
      idempotencyKey: callCancelMessageKey(booking.id),
    });
    return { booking, messageId: recorded.created ? recorded.id : null };
  });
  if (!cancelled) return false;
  const { booking, messageId } = cancelled;
  // Отмена уже в базе: сбой очереди не делает её неудачной
  if (messageId) await scheduleOutboundSend(deps.queue, messageId).catch(logLater(`Отмена созвона ${booking.id}: сообщение человеку не поставлено`));
  await queueCallNotices(deps, { kind: "cancelled", booking }).catch(logLater(`Отмена созвона ${booking.id}: уведомление не поставлено`));
  return true;
}
