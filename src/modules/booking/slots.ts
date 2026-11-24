// Окна эксперта и нарезка на созвоны: чистые функции без базы. Время приходит аргументом, пояс — IANA эксперта.
import { addDays, atLocalTime, localDate } from "../program/calendar";

/**
 * Окно эксперта: промежуток, в который он готов созвониться, по своим часам. Конец раньше начала (или равен ему не
 * бывает) — окно через полночь, кончается назавтра. `weekly` — повторяется каждую неделю с `date`.
 */
export interface CallWindow {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  weekly: boolean;
}

export interface CallInterval {
  startsAt: Date;
  endsAt: Date;
}

/** Ближе этого к «сейчас» созвон не предлагается: человеку и эксперту нужно время подготовиться. */
export const CALL_NOTICE_MINUTES = 60;

const WEEK_DAYS = 7;
const MINUTE_MS = 60_000;

function occurrenceOn(window: CallWindow, date: string, timeZone: string): CallInterval {
  const crossesMidnight = window.endTime <= window.startTime;
  return {
    startsAt: atLocalTime(date, window.startTime, timeZone),
    endsAt: atLocalTime(crossesMidnight ? addDays(date, 1) : date, window.endTime, timeZone),
  };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * 60 * MINUTE_MS));
}

/** Повторы окна, которые пересекают `[from, until)`, по порядку. */
export function windowOccurrences(window: CallWindow, timeZone: string, from: Date, until: Date): CallInterval[] {
  if (!window.weekly) {
    const once = occurrenceOn(window, window.date, timeZone);
    return once.endsAt > from && once.startsAt < until ? [once] : [];
  }
  // С недели, в которой мог начаться повтор, ещё идущий в `from` (окно через полночь — с прошлого дня)
  const firstDay = addDays(localDate(from, timeZone), -1);
  const skipWeeks = Math.max(0, Math.floor(daysBetween(window.date, firstDay) / WEEK_DAYS));
  const result: CallInterval[] = [];
  for (let week = skipWeeks; ; week++) {
    const occurrence = occurrenceOn(window, addDays(window.date, week * WEEK_DAYS), timeZone);
    if (occurrence.startsAt >= until) return result;
    if (occurrence.endsAt > from) result.push(occurrence);
  }
}

export interface FreeSlotsInput {
  windows: readonly CallWindow[];
  /** Занятое время: действующие записи. */
  busy: readonly CallInterval[];
  timeZone: string;
  callMinutes: number;
  now: Date;
  until: Date;
}

const overlaps = (a: CallInterval, b: CallInterval) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** Свободные созвоны по порядку: окна нарезаны с их начала шагом длины созвона, прошедшие, близкие и занятые выпали. */
export function freeCallSlots(input: FreeSlotsInput): CallInterval[] {
  const earliest = new Date(input.now.getTime() + CALL_NOTICE_MINUTES * MINUTE_MS);
  const callMs = input.callMinutes * MINUTE_MS;
  const byStart = new Map<number, CallInterval>();
  for (const window of input.windows) {
    for (const occurrence of windowOccurrences(window, input.timeZone, earliest, input.until)) {
      for (let start = occurrence.startsAt.getTime(); start + callMs <= occurrence.endsAt.getTime(); start += callMs) {
        const slot = { startsAt: new Date(start), endsAt: new Date(start + callMs) };
        if (slot.startsAt < earliest || slot.startsAt >= input.until || byStart.has(start)) continue;
        if (input.busy.some((busy) => overlaps(busy, slot))) continue;
        byStart.set(start, slot);
      }
    }
  }
  return [...byStart.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

const LOCAL_START = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/** Начало созвона по часам эксперта (`ГГГГ-ММ-ДДTЧЧ:ММ`) как момент; не время — `null`. */
export function localStartToInstant(localStart: string, timeZone: string): Date | null {
  const match = LOCAL_START.exec(localStart.trim());
  if (!match) return null;
  return atLocalTime(match[1]!, `${match[2]}:${match[3]}`, timeZone);
}

/** Свободный созвон, который начинается в `localStart` по часам эксперта; занят, вне окон или не время — `null`. */
export function callSlotAt(input: Omit<FreeSlotsInput, "until">, localStart: string): CallInterval | null {
  const startsAt = localStartToInstant(localStart, input.timeZone);
  if (!startsAt) return null;
  const until = new Date(startsAt.getTime() + input.callMinutes * MINUTE_MS + 1);
  return freeCallSlots({ ...input, until }).find((slot) => slot.startsAt.getTime() === startsAt.getTime()) ?? null;
}

const labelFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}:${JSON.stringify(options)}`;
  let found = labelFormatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat("ru-RU", { timeZone, ...options });
    labelFormatters.set(key, found);
  }
  return found;
}

/** Смещение пояса в момент `at`: «UTC+3», «UTC+5:30», «UTC». */
export function timeZoneOffsetLabel(timeZone: string, at: Date): string {
  const name = formatter(timeZone, { timeZoneName: "shortOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  return name.replace("GMT", "UTC").replace(/^UTC[+-]0$/, "UTC");
}

/** День созвона по часам пояса: «пт, 20 ноября». */
export function dayLabel(at: Date, timeZone: string): string {
  return formatter(timeZone, { weekday: "short", day: "numeric", month: "long" }).format(at);
}

/** Время по часам пояса: «10:00». */
export function clockLabel(at: Date, timeZone: string): string {
  return formatter(timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

/** «пт, 20 ноября, 10:00–10:30 (UTC+3)». */
export function slotLabel(slot: CallInterval, timeZone: string): string {
  return `${dayLabel(slot.startsAt, timeZone)}, ${clockLabel(slot.startsAt, timeZone)}–${clockLabel(slot.endsAt, timeZone)} (${timeZoneOffsetLabel(timeZone, slot.startsAt)})`;
}

/** Начало созвона по часам эксперта для инструмента: `ГГГГ-ММ-ДДTЧЧ:ММ`. */
export function localStartOf(at: Date, timeZone: string): string {
  return `${localDate(at, timeZone)}T${clockLabel(at, timeZone)}`;
}
