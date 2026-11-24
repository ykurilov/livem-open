import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { isValidTimeZone } from "../program/calendar";
import type { Database, DatabaseExecutor } from "../platform/db";
import { callBookings, callCalendar, callWindows, type CallBookingRow } from "./schema";
import { windowOccurrences, type CallWindow } from "./slots";

export interface CallCalendarSettings {
  timeZone: string;
  callMinutes: number;
}

const CALENDAR_ROW_ID = 1;
export const CALL_MINUTES_MIN = 10;
export const CALL_MINUTES_MAX = 240;

export async function readCallCalendar(db: DatabaseExecutor): Promise<CallCalendarSettings> {
  const [row] = await db.select().from(callCalendar).where(eq(callCalendar.id, CALENDAR_ROW_ID));
  return row ? { timeZone: row.timeZone, callMinutes: row.callMinutes } : { timeZone: "Europe/Moscow", callMinutes: 30 };
}

export async function listCallWindows(db: DatabaseExecutor): Promise<CallWindow[]> {
  const rows = await db.select().from(callWindows).orderBy(callWindows.date, callWindows.startTime);
  return rows.map(({ id, date, startTime, endTime, weekly }) => ({ id, date, startTime, endTime, weekly }));
}

/**
 * Правка календаря, после которой действующие записи в будущем оказались бы вне окон: эксперт видит их до сохранения.
 * С согласием (`confirm`) правка сохраняется, записи остаются в силе — созвон состоится, отменить его можно в «Записях».
 */
export type CalendarChangeResult<T> = { ok: true; value: T } | { ok: false; error: string } | { ok: false; outside: CallBookingRow[] };

interface ChangeOptions {
  now: Date;
  confirm: boolean;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const windowInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Дата окна — в виде ГГГГ-ММ-ДД").refine((date) => !Number.isNaN(Date.parse(`${date}T00:00:00Z`)), "Нет такой даты"),
    startTime: z.string().regex(TIME, "Начало окна — в виде ЧЧ:ММ"),
    endTime: z.string().regex(TIME, "Конец окна — в виде ЧЧ:ММ"),
    weekly: z.boolean(),
  })
  .refine((window) => window.startTime !== window.endTime, "Начало и конец окна совпадают");

export type CallWindowInput = z.input<typeof windowInputSchema>;

/** Действующие записи в будущем, кроме тестовых. */
async function upcomingBookings(db: DatabaseExecutor, now: Date): Promise<CallBookingRow[]> {
  return db
    .select()
    .from(callBookings)
    .where(and(eq(callBookings.status, "booked"), isNull(callBookings.testChatId), gt(callBookings.endsAt, now)))
    .orderBy(callBookings.startsAt);
}

function fitsWindows(booking: CallBookingRow, windows: readonly CallWindow[], timeZone: string): boolean {
  return windows.some((window) =>
    windowOccurrences(window, timeZone, booking.startsAt, booking.endsAt).some((occurrence) => occurrence.startsAt <= booking.startsAt && occurrence.endsAt >= booking.endsAt),
  );
}

/** Записи, которые были в окнах до правки и вышли из них после. Записи вне окон и раньше (эксперт уже согласился) не повторяются. */
async function bookingsLeftOutside(
  db: DatabaseExecutor,
  now: Date,
  before: { windows: readonly CallWindow[]; timeZone: string },
  after: { windows: readonly CallWindow[]; timeZone: string },
): Promise<CallBookingRow[]> {
  const bookings = await upcomingBookings(db, now);
  return bookings.filter((booking) => fitsWindows(booking, before.windows, before.timeZone) && !fitsWindows(booking, after.windows, after.timeZone));
}

/** Запись на созвон держит календарь от правки до конца своей транзакции (правка берёт его на изменение). */
export async function shareLockCalendar(tx: DatabaseExecutor): Promise<void> {
  await tx.select({ id: callCalendar.id }).from(callCalendar).where(eq(callCalendar.id, CALENDAR_ROW_ID)).for("share");
}

/** Под замком строки календаря: две правки сразу не пропустят друг у друга записи вне окон. */
async function lockCalendar(tx: DatabaseExecutor): Promise<CallCalendarSettings> {
  await tx.insert(callCalendar).values({ id: CALENDAR_ROW_ID }).onConflictDoNothing();
  const [row] = await tx.select().from(callCalendar).where(eq(callCalendar.id, CALENDAR_ROW_ID)).for("update");
  return { timeZone: row!.timeZone, callMinutes: row!.callMinutes };
}

export async function saveCallWindow(db: Database, input: CallWindowInput, options: ChangeOptions): Promise<CalendarChangeResult<CallWindow>> {
  const parsed = windowInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Окно заполнено неверно" };
  const { id, ...fields } = parsed.data;
  return db.transaction(async (tx) => {
    const calendar = await lockCalendar(tx);
    const windows = await listCallWindows(tx);
    if (id && !windows.some((window) => window.id === id)) return { ok: false, error: "Окно уже удалено" };
    const saved: CallWindow = { id: id ?? "new", ...fields };
    const after = id ? windows.map((window) => (window.id === id ? saved : window)) : [...windows, saved];
    if (!options.confirm) {
      const outside = await bookingsLeftOutside(tx, options.now, { windows, timeZone: calendar.timeZone }, { windows: after, timeZone: calendar.timeZone });
      if (outside.length > 0) return { ok: false, outside };
    }
    if (id) {
      await tx.update(callWindows).set(fields).where(eq(callWindows.id, id));
      return { ok: true, value: saved };
    }
    const [created] = await tx.insert(callWindows).values(fields).returning();
    return { ok: true, value: { ...saved, id: created!.id } };
  });
}

export async function deleteCallWindow(db: Database, id: string, options: ChangeOptions): Promise<CalendarChangeResult<null>> {
  return db.transaction(async (tx) => {
    const calendar = await lockCalendar(tx);
    const windows = await listCallWindows(tx);
    if (!windows.some((window) => window.id === id)) return { ok: true, value: null };
    if (!options.confirm) {
      const after = windows.filter((window) => window.id !== id);
      const outside = await bookingsLeftOutside(tx, options.now, { windows, timeZone: calendar.timeZone }, { windows: after, timeZone: calendar.timeZone });
      if (outside.length > 0) return { ok: false, outside };
    }
    await tx.delete(callWindows).where(eq(callWindows.id, id));
    return { ok: true, value: null };
  });
}

export async function updateCallCalendar(
  db: Database,
  changes: Partial<CallCalendarSettings>,
  options: ChangeOptions,
): Promise<CalendarChangeResult<CallCalendarSettings>> {
  if (changes.timeZone !== undefined && !isValidTimeZone(changes.timeZone)) return { ok: false, error: "Такого часового пояса нет" };
  if (changes.callMinutes !== undefined && (!Number.isInteger(changes.callMinutes) || changes.callMinutes < CALL_MINUTES_MIN || changes.callMinutes > CALL_MINUTES_MAX))
    return { ok: false, error: `Длина созвона — от ${CALL_MINUTES_MIN} до ${CALL_MINUTES_MAX} минут` };
  return db.transaction(async (tx) => {
    const calendar = await lockCalendar(tx);
    const next = { ...calendar, ...changes };
    // Длина созвона уже сделанных записей не меняет: проверка — только когда окна сдвигает новый пояс
    if (!options.confirm && next.timeZone !== calendar.timeZone) {
      const windows = await listCallWindows(tx);
      const outside = await bookingsLeftOutside(tx, options.now, { windows, timeZone: calendar.timeZone }, { windows, timeZone: next.timeZone });
      if (outside.length > 0) return { ok: false, outside };
    }
    await tx.update(callCalendar).set(next).where(eq(callCalendar.id, CALENDAR_ROW_ID));
    return { ok: true, value: next };
  });
}
