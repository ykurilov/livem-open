// Календарь программы: чистые функции без базы. Время приходит аргументом, пояс — IANA («Asia/Novosibirsk»).

export const DEFAULT_TIME_ZONE = "Europe/Moscow";
/** С этого часа по времени человека начинается следующий день программы. */
export const DAY_STARTS_AT = "05:00";

const DAY_MS = 24 * 60 * 60_000;

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Пояс человека; пока он неизвестен или записан неверно — Москва. */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Настенные часы и дата момента в поясе. */
function wallClock(at: Date, timeZone: string): Wall {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(at)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute! };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Дата момента по поясу: `YYYY-MM-DD`. */
export function localDate(at: Date, timeZone: string | null | undefined): string {
  const wall = wallClock(at, resolveTimeZone(timeZone));
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** Время момента по поясу: `ЧЧ:ММ`. */
export function localTime(at: Date, timeZone: string | null | undefined): string {
  const wall = wallClock(at, resolveTimeZone(timeZone));
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
}

function parseTime(time: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new Error(`Время должно быть в виде ЧЧ:ММ, получено: ${time}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Дата должна быть в виде ГГГГ-ММ-ДД, получено: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Дата, сдвинутая на `days` суток (в обе стороны). */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

/** Момент, когда в поясе на настенных часах `date` и `time`. Переход на летнее время учтён. */
export function atLocalTime(date: string, time: string, timeZone: string | null | undefined): Date {
  const zone = resolveTimeZone(timeZone);
  const { year, month, day } = parseDate(date);
  const { hour, minute } = parseTime(time);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const wall = wallClock(new Date(instant), zone);
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - Math.floor(instant / 60_000) * 60_000;
  };
  // Смещение зависит от самого момента: уточняем дважды, этого хватает для любого перехода
  let instant = wallAsUtc - offsetAt(wallAsUtc);
  instant = wallAsUtc - offsetAt(instant);
  return new Date(instant);
}

/** Ближайший строго следующий момент, когда у человека на часах `time`. */
export function nextLocalTime(time: string, from: Date, timeZone: string | null | undefined): Date {
  parseTime(time);
  const today = localDate(from, timeZone);
  const candidate = atLocalTime(today, time, timeZone);
  return candidate > from ? candidate : atLocalTime(addDays(today, 1), time, timeZone);
}

/** Дата дня 1: календарный день первого сообщения по поясу человека. Ночной старт — та же дата. */
export function programStartDate(startedAt: Date, timeZone: string | null | undefined): string {
  return localDate(startedAt, timeZone);
}

export interface ProgramDayInput {
  startDate: string;
  now: Date;
  timeZone: string | null | undefined;
}

/**
 * Номер дня программы. День N начинается в 5:00 по времени человека в дату `startDate + N − 1`;
 * до 5:00 ещё идёт прошлый день. День 1 — вся дата `startDate` и ночь после неё.
 */
export function programDay({ startDate, now, timeZone }: ProgramDayInput): number {
  const zone = resolveTimeZone(timeZone);
  const today = localDate(now, zone);
  const calendarDate = localTime(now, zone) < DAY_STARTS_AT ? addDays(today, -1) : today;
  return Math.max(1, daysBetween(startDate, calendarDate) + 1);
}

/** Начало дня: 5:00 по времени человека. День 1 «начинается» в полночь своей даты. */
export function dayStartsAt(startDate: string, day: number, timeZone: string | null | undefined): Date {
  return atLocalTime(addDays(startDate, day - 1), day <= 1 ? "00:00" : DAY_STARTS_AT, timeZone);
}

/** Конец программы: 5:00 после последнего дня. */
export function termEndsAt(startDate: string, days: number, timeZone: string | null | undefined): Date {
  return dayStartsAt(startDate, days + 1, timeZone);
}
