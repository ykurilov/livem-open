import { and, eq, notInArray } from "drizzle-orm";
import type { DatabaseExecutor } from "../platform/db";
import { callBookings, type CallBookingRow } from "./schema";

// Тестовые записи разговора «Проверки» лежат вне ветки сообщений: правка реплики возвращает их к началу того хода

const DATE_FIELDS = ["startsAt", "endsAt", "cancelledAt", "reminderSentAt", "createdAt"] as const;
type DateField = (typeof DATE_FIELDS)[number];

/** Тестовая запись в снимке хода (JSON): даты — строками ISO. */
export type SavedTestBooking = Omit<CallBookingRow, DateField> & { [K in DateField]: CallBookingRow[K] extends Date ? string : string | null };

export async function saveTestBookings(db: DatabaseExecutor, chatId: string): Promise<SavedTestBooking[]> {
  const rows = await db.select().from(callBookings).where(eq(callBookings.testChatId, chatId));
  return rows.map((row) => ({
    ...row,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    reminderSentAt: row.reminderSentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Записи тестового чата — ровно как в снимке: сделанные позже удаляются, перенесённые и отменённые возвращаются. */
export async function restoreTestBookings(db: DatabaseExecutor, chatId: string, saved: readonly SavedTestBooking[]): Promise<void> {
  const ids = saved.map((booking) => booking.id);
  await db.delete(callBookings).where(and(eq(callBookings.testChatId, chatId), ...(ids.length ? [notInArray(callBookings.id, ids)] : [])));
  for (const booking of saved) {
    const row: CallBookingRow = {
      ...booking,
      startsAt: new Date(booking.startsAt),
      endsAt: new Date(booking.endsAt),
      cancelledAt: booking.cancelledAt ? new Date(booking.cancelledAt) : null,
      reminderSentAt: booking.reminderSentAt ? new Date(booking.reminderSentAt) : null,
      createdAt: new Date(booking.createdAt),
    };
    const { id: _id, ...columns } = row;
    await db.insert(callBookings).values(row).onConflictDoUpdate({ target: callBookings.id, set: columns });
  }
}
