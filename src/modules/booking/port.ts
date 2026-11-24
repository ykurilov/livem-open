import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import { bookCall, cancelCall, currentBookingOf, freeCallTimes, rescheduleCall, type CallParty } from "./bookings";
import { readCallCalendar } from "./calendar";
import type { CallBookingRow } from "./schema";
import type { CallBookingPort } from "./tool";

type Chat = { ownerId: string; chatId: string };

/** Что изменилось после хода агента: по этому живой разговор шлёт уведомления и ставит напоминание, «Проверка» — нет. */
export type CallBookingChange =
  | { kind: "booked"; booking: CallBookingRow }
  | { kind: "rescheduled"; booking: CallBookingRow; previous: CallBookingRow }
  | { kind: "cancelled"; booking: CallBookingRow };

export interface CallBookingPortDependencies {
  db: Database;
  clock: Clock;
  /** Кто записывается из этого чата и ссылка на встречу из настройки его версии. Чата нет — `null`. */
  partyOf(chat: Chat): Promise<{ party: CallParty; meetingLink: string | null } | null>;
  /** После удачной записи, переноса или отмены. Ошибка здесь не отменяет запись: она уже в базе. */
  onChange(change: CallBookingChange, chat: Chat): Promise<void>;
}

export function createCallBookingPort(deps: CallBookingPortDependencies): CallBookingPort {
  const requireParty = async (chat: Chat) => {
    const found = await deps.partyOf(chat);
    if (!found) throw new Error(`Чат ${chat.chatId}: не найден разговор для записи на созвон`);
    return found;
  };
  const afterChange = async (change: CallBookingChange, chat: Chat) => {
    try {
      await deps.onChange(change, chat);
    } catch (error) {
      console.error(`Запись на созвон ${change.booking.id}: последствия не доделаны:`, error instanceof Error ? error.message : error);
    }
  };
  return {
    async freeTimes(chat) {
      const now = deps.clock.now();
      const [free, found] = await Promise.all([freeCallTimes(deps.db, { now }), deps.partyOf(chat)]);
      const booking = found ? await currentBookingOf(deps.db, found.party, now) : null;
      return { ...free, booking };
    },
    async book(chat, start) {
      const { party, meetingLink } = await requireParty(chat);
      const now = deps.clock.now();
      const result = await bookCall(deps.db, { party, localStart: start, now, meetingLink });
      const { timeZone } = await readCallCalendar(deps.db);
      if (!result.ok) {
        const booking = result.reason === "has_booking" ? await currentBookingOf(deps.db, party, now) : null;
        return { ok: false, reason: result.reason, timeZone, ...(booking && { booking }) };
      }
      await afterChange({ kind: "booked", booking: result.booking }, chat);
      return { ok: true, booking: result.booking, timeZone };
    },
    async reschedule(chat, start) {
      const { party } = await requireParty(chat);
      const result = await rescheduleCall(deps.db, { party, localStart: start, now: deps.clock.now() });
      const { timeZone } = await readCallCalendar(deps.db);
      if (!result.ok) return { ok: false, reason: result.reason, timeZone };
      await afterChange({ kind: "rescheduled", booking: result.booking, previous: result.previous }, chat);
      return { ok: true, booking: result.booking, timeZone };
    },
    async cancel(chat) {
      const { party } = await requireParty(chat);
      const result = await cancelCall(deps.db, { party, now: deps.clock.now() });
      if (!result.ok) return { ok: false };
      await afterChange({ kind: "cancelled", booking: result.booking }, chat);
      return { ok: true };
    },
  };
}
