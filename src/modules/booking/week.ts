import { addDays, atLocalTime, localDate } from "../program/calendar";
import { clockLabel, dayLabel, timeZoneOffsetLabel, windowOccurrences, type CallWindow } from "./slots";
import type { CallBookingStatus } from "./schema";

const WEEK_DAYS = 7;

/** Понедельник недели, в которую входит день `date` (ГГГГ-ММ-ДД). */
export function weekStartOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

export interface CallWeekBookingInput {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: CallBookingStatus;
  personId: string | null;
  personName: string | null;
}

export interface CallWeekDay {
  date: string;
  /** «пн, 16 ноября». */
  label: string;
  /** День уже прошёл по часам эксперта. */
  past: boolean;
  windows: Array<CallWindow & { time: string }>;
  bookings: Array<CallWeekBookingInput & { time: string }>;
}

export interface CallWeek {
  weekStart: string;
  previousWeek: string;
  nextWeek: string;
  /** «UTC+3» — пояс эксперта на эту неделю. */
  offset: string;
  days: CallWeekDay[];
}

/** Неделя календаря по часам эксперта: окна (повторяющиеся — в каждой неделе) и действующие записи по дням. */
export function callWeek(input: { weekStart: string; timeZone: string; now: Date; windows: readonly CallWindow[]; bookings: readonly CallWeekBookingInput[] }): CallWeek {
  const { timeZone } = input;
  const today = localDate(input.now, timeZone);
  const range = (from: Date, to: Date) => `${clockLabel(from, timeZone)}–${clockLabel(to, timeZone)}`;
  const days: CallWeekDay[] = [];
  for (let index = 0; index < WEEK_DAYS; index++) {
    const date = addDays(input.weekStart, index);
    const dayStart = atLocalTime(date, "00:00", timeZone);
    const dayEnd = atLocalTime(addDays(date, 1), "00:00", timeZone);
    const windows = input.windows
      .flatMap((window) =>
        windowOccurrences(window, timeZone, dayStart, dayEnd)
          // Окно через полночь — только в день, когда оно начинается
          .filter((occurrence) => occurrence.startsAt >= dayStart)
          .map((occurrence) => ({ ...window, time: range(occurrence.startsAt, occurrence.endsAt), sortKey: occurrence.startsAt.getTime() })),
      )
      .sort((a, b) => a.sortKey - b.sortKey)
      .map(({ sortKey: _sortKey, ...window }) => window);
    const bookings = input.bookings
      .filter((booking) => booking.status === "booked" && booking.startsAt >= dayStart && booking.startsAt < dayEnd)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((booking) => ({ ...booking, time: range(booking.startsAt, booking.endsAt) }));
    days.push({ date, label: dayLabel(dayStart, timeZone), past: date < today, windows, bookings });
  }
  return {
    weekStart: input.weekStart,
    previousWeek: addDays(input.weekStart, -WEEK_DAYS),
    nextWeek: addDays(input.weekStart, WEEK_DAYS),
    offset: timeZoneOffsetLabel(timeZone, atLocalTime(input.weekStart, "12:00", timeZone)),
    days,
  };
}
