import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { REPLY_WINDOW_CLOSED_ERROR } from "../channels/outbound";
import { outboundMessages } from "../channels/schema";
import type { Database, DatabaseExecutor } from "../platform/db";
import { leadMagnets } from "../lead-magnets/schema";
import { people } from "../people/schema";
import { listCallWindows, readCallCalendar, shareLockCalendar } from "./calendar";
import { callBookings, type CallBookingRow } from "./schema";
import { callSlotAt, freeCallSlots, localStartToInstant, type CallInterval } from "./slots";

/** Кто записывается: человек из живого разговора или чат «Проверки» (тестовая запись: окон не занимает). */
export type CallParty =
  | { kind: "person"; personId: string; passageId: string; leadMagnetId: string | null }
  | { kind: "test"; chatId: string; leadMagnetId: string | null };

/** Отказ записи: время занято или вне окон, не время, у человека уже есть запись в будущем, записи нет. */
export type CallRefusal = "not_free" | "bad_time" | "has_booking" | "no_booking";

/** Насколько вперёд агент видит свободное время. */
export const FREE_TIMES_HORIZON_DAYS = 28;
const DAY_MS = 24 * 60 * 60_000;
const EXCLUSION_VIOLATION = "23P01";

function isOverlapViolation(error: unknown): boolean {
  const found = (error as { code?: string; cause?: { code?: string } }) ?? {};
  return found.code === EXCLUSION_VIOLATION || found.cause?.code === EXCLUSION_VIOLATION;
}

const partyFilter = (party: CallParty) =>
  party.kind === "person" ? and(eq(callBookings.personId, party.personId), isNull(callBookings.testChatId)) : eq(callBookings.testChatId, party.chatId);

/** Действующие записи, которые занимают окна: тестовые не в счёт. */
async function busyIntervals(db: DatabaseExecutor, from: Date, until: Date, exceptId?: string): Promise<CallInterval[]> {
  return db
    .select({ startsAt: callBookings.startsAt, endsAt: callBookings.endsAt })
    .from(callBookings)
    .where(
      and(
        eq(callBookings.status, "booked"),
        isNull(callBookings.testChatId),
        gt(callBookings.endsAt, from),
        lt(callBookings.startsAt, until),
        exceptId ? ne(callBookings.id, exceptId) : undefined,
      ),
    );
}

export interface FreeCallTimes {
  timeZone: string;
  callMinutes: number;
  slots: CallInterval[];
}

export async function freeCallTimes(db: DatabaseExecutor, options: { now: Date; until?: Date }): Promise<FreeCallTimes> {
  const until = options.until ?? new Date(options.now.getTime() + FREE_TIMES_HORIZON_DAYS * DAY_MS);
  const [calendar, windows, busy] = await Promise.all([readCallCalendar(db), listCallWindows(db), busyIntervals(db, options.now, until)]);
  return { ...calendar, slots: freeCallSlots({ windows, busy, timeZone: calendar.timeZone, callMinutes: calendar.callMinutes, now: options.now, until }) };
}

/** Действующая запись участника, которая ещё не прошла. Прошедшие остаются `booked` как история и записаться снова не мешают. */
export async function currentBookingOf(db: DatabaseExecutor, party: CallParty, now: Date): Promise<CallBookingRow | null> {
  const [row] = await db
    .select()
    .from(callBookings)
    .where(and(partyFilter(party), eq(callBookings.status, "booked"), gt(callBookings.endsAt, now)))
    .orderBy(asc(callBookings.startsAt))
    .limit(1);
  return row ?? null;
}

/** Записи одного участника идут по очереди: «одна запись в будущем» не ломается двумя разговорами сразу. */
async function lockParty(tx: DatabaseExecutor, party: CallParty): Promise<void> {
  const key = party.kind === "person" ? `call:${party.personId}` : `call:test:${party.chatId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/** Свободный созвон в `localStart` по часам эксперта или причина отказа. */
async function slotFor(tx: DatabaseExecutor, localStart: string, now: Date, exceptId?: string): Promise<CallInterval | "not_free" | "bad_time"> {
  // Правка окон ждёт записи, запись — правки: удалённое окно не примет запись, а новая запись видна проверке «вне окон»
  await shareLockCalendar(tx);
  const calendar = await readCallCalendar(tx);
  const startsAt = localStartToInstant(localStart, calendar.timeZone);
  if (!startsAt) return "bad_time";
  const windows = await listCallWindows(tx);
  const busy = await busyIntervals(tx, startsAt, new Date(startsAt.getTime() + calendar.callMinutes * 60_000), exceptId);
  return callSlotAt({ windows, busy, timeZone: calendar.timeZone, callMinutes: calendar.callMinutes, now }, localStart) ?? "not_free";
}

const partyColumns = (party: CallParty) =>
  party.kind === "person"
    ? { personId: party.personId, passageId: party.passageId, testChatId: null }
    : { personId: null, passageId: null, testChatId: party.chatId };

export type BookCallResult = { ok: true; booking: CallBookingRow } | { ok: false; reason: CallRefusal };

/** Гонка двух разговоров за одно время решается базой: второй получает «занято» (исключающее ограничение). */
export async function bookCall(
  db: Database,
  input: { party: CallParty; localStart: string; now: Date; meetingLink: string | null },
): Promise<BookCallResult> {
  try {
    return await db.transaction(async (tx): Promise<BookCallResult> => {
      await lockParty(tx, input.party);
      if (await currentBookingOf(tx, input.party, input.now)) return { ok: false, reason: "has_booking" };
      const slot = await slotFor(tx, input.localStart, input.now);
      if (typeof slot === "string") return { ok: false, reason: slot };
      const [booking] = await tx
        .insert(callBookings)
        .values({ ...slot, ...partyColumns(input.party), leadMagnetId: input.party.leadMagnetId, meetingLink: input.meetingLink })
        .returning();
      return { ok: true, booking: booking! };
    });
  } catch (error) {
    if (isOverlapViolation(error)) return { ok: false, reason: "not_free" };
    throw error;
  }
}

export type RescheduleCallResult = { ok: true; booking: CallBookingRow; previous: CallBookingRow } | { ok: false; reason: CallRefusal };

/** Перенос — одним действием: прежняя запись `rescheduled` со ссылкой на новую; новое время занято — прежняя остаётся. */
export async function rescheduleCall(db: Database, input: { party: CallParty; localStart: string; now: Date }): Promise<RescheduleCallResult> {
  try {
    return await db.transaction(async (tx): Promise<RescheduleCallResult> => {
      await lockParty(tx, input.party);
      const current = await currentBookingOf(tx, input.party, input.now);
      if (!current) return { ok: false, reason: "no_booking" };
      const slot = await slotFor(tx, input.localStart, input.now, current.id);
      if (typeof slot === "string") return { ok: false, reason: slot };
      // Эксперт мог отменить запись, пока шла проверка: отмена остаётся в силе
      const [moved] = await tx
        .update(callBookings)
        .set({ status: "rescheduled" })
        .where(and(eq(callBookings.id, current.id), eq(callBookings.status, "booked")))
        .returning({ id: callBookings.id });
      if (!moved) return { ok: false, reason: "no_booking" };
      const [booking] = await tx
        .insert(callBookings)
        .values({
          ...slot,
          ...partyColumns(input.party),
          leadMagnetId: input.party.leadMagnetId ?? current.leadMagnetId,
          meetingLink: current.meetingLink,
        })
        .returning();
      const [previous] = await tx.update(callBookings).set({ rescheduledToId: booking!.id }).where(eq(callBookings.id, current.id)).returning();
      return { ok: true, booking: booking!, previous: previous! };
    });
  } catch (error) {
    if (isOverlapViolation(error)) return { ok: false, reason: "not_free" };
    throw error;
  }
}

export type CancelCallResult = { ok: true; booking: CallBookingRow } | { ok: false; reason: "no_booking" };

export async function cancelCall(db: Database, input: { party: CallParty; now: Date }): Promise<CancelCallResult> {
  return db.transaction(async (tx): Promise<CancelCallResult> => {
    await lockParty(tx, input.party);
    const current = await currentBookingOf(tx, input.party, input.now);
    if (!current) return { ok: false, reason: "no_booking" };
    const [booking] = await tx
      .update(callBookings)
      .set({ status: "cancelled", cancelledBy: "person", cancelledAt: input.now })
      .where(eq(callBookings.id, current.id))
      .returning();
    return { ok: true, booking: booking! };
  });
}

/** Отмена из «Записей». Уже отменённая или перенесённая — `null`. */
export async function cancelBookingByExpert(db: DatabaseExecutor, bookingId: string, now: Date): Promise<CallBookingRow | null> {
  const [booking] = await db
    .update(callBookings)
    .set({ status: "cancelled", cancelledBy: "expert", cancelledAt: now })
    .where(and(eq(callBookings.id, bookingId), eq(callBookings.status, "booked"), isNull(callBookings.testChatId)))
    .returning();
  return booking ?? null;
}

export interface CallBookingListRow extends CallBookingRow {
  personName: string | null;
  leadMagnetName: string | null;
  /** Напоминание человеку не дошло: почему, для эксперта. */
  reminderFailure: string | null;
  /** Сообщение человеку об отмене экспертом не дошло: почему. */
  cancelMessageFailure: string | null;
}

/** Ключи исходящих по записи: по ним видно, дошло ли напоминание и сообщение об отмене. */
export const callReminderKey = (bookingId: string) => `call-reminder:${bookingId}`;
export const callCancelMessageKey = (bookingId: string) => `call-cancelled:${bookingId}`;

/** Почему сообщение человеку не дошло — словами для эксперта. */
export function undeliveredText(status: "failed" | "blocked", error: string | null): string {
  if (status === "blocked") return "Человек остановил бота.";
  if (error === REPLY_WINDOW_CLOSED_ERROR) return "Мессенджер не даёт боту писать первым, пока человек сам не напишет.";
  return `Мессенджер не принял сообщение${error ? `: ${error}` : ""}.`;
}

/** Исходящее записи с ключом `prefix` + id (`callReminderKey`, `callCancelMessageKey`), если оно окончательно не ушло. */
export const undeliveredMessageJoin = (messages: { idempotencyKey: AnyPgColumn; status: AnyPgColumn }, prefix: "call-reminder:" | "call-cancelled:") =>
  and(eq(messages.idempotencyKey, sql`${prefix} || ${callBookings.id}::text`), inArray(messages.status, ["failed", "blocked"]))!;

const failureOf = (message: { status: string | null; error: string | null } | null) =>
  message?.status === "failed" || message?.status === "blocked" ? undeliveredText(message.status, message.error) : null;

const cancelMessages = alias(outboundMessages, "cancel_messages");

/** «Записи»: настоящие записи с `now − pastDays` и дальше, по времени созвона. Тестовых «Проверки» нет. */
export async function listCallBookings(db: DatabaseExecutor, options: { now: Date; pastDays?: number }): Promise<CallBookingListRow[]> {
  const from = new Date(options.now.getTime() - (options.pastDays ?? 30) * DAY_MS);
  const rows = await db
    .select({
      booking: callBookings,
      personName: people.displayName,
      leadMagnetName: sql<string | null>`${leadMagnets.draft}->>'name'`,
      reminder: { status: outboundMessages.status, error: outboundMessages.error },
      cancelMessage: { status: cancelMessages.status, error: cancelMessages.error },
    })
    .from(callBookings)
    .leftJoin(people, eq(people.id, callBookings.personId))
    .leftJoin(leadMagnets, eq(leadMagnets.id, callBookings.leadMagnetId))
    .leftJoin(outboundMessages, undeliveredMessageJoin(outboundMessages, "call-reminder:"))
    .leftJoin(cancelMessages, undeliveredMessageJoin(cancelMessages, "call-cancelled:"))
    .where(and(isNull(callBookings.testChatId), gte(callBookings.startsAt, from)))
    .orderBy(asc(callBookings.startsAt), asc(callBookings.createdAt));
  return rows.map(({ booking, personName, leadMagnetName, reminder, cancelMessage }) => ({
    ...booking,
    personName,
    leadMagnetName,
    reminderFailure: failureOf(reminder),
    cancelMessageFailure: failureOf(cancelMessage),
  }));
}
