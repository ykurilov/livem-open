// Единственное место, где код приложения узнаёт время. Тесты подменяют часы.

export type QuietHours = readonly [from: string, to: string];

export interface Clock {
  now(): Date;
  /** Дата по Москве в виде YYYY-MM-DD. */
  mskDate(at?: Date): string;
  /** Ближайший строго следующий момент, когда в Москве будет `time` («10:00»). */
  nextMskTime(time: string, from?: Date): Date;
  /** Попадает ли момент в тихие часы (по умолчанию 22:00–09:00 по Москве). */
  isQuietHours(at?: Date, quiet?: QuietHours): boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHours = ["22:00", "09:00"];

// В Москве нет перехода на летнее время: UTC+3 круглый год
const MSK_OFFSET_MS = 3 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

function parseTime(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new Error(`Время должно быть в виде ЧЧ:ММ, получено: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function mskMinutesOfDay(at: Date): number {
  const msk = at.getTime() + MSK_OFFSET_MS;
  return Math.floor(positiveModulo(msk, DAY_MS) / MINUTE_MS);
}

export function createClock(readNow: () => Date): Clock {
  const clock: Clock = {
    now: readNow,

    mskDate(at = readNow()) {
      return new Date(at.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
    },

    nextMskTime(time, from = readNow()) {
      const targetMinutes = parseTime(time);
      const mskMillis = from.getTime() + MSK_OFFSET_MS;
      const mskMidnightUtc = mskMillis - positiveModulo(mskMillis, DAY_MS) - MSK_OFFSET_MS;
      let candidate = mskMidnightUtc + targetMinutes * MINUTE_MS;
      if (candidate <= from.getTime()) candidate += DAY_MS;
      return new Date(candidate);
    },

    isQuietHours(at = readNow(), quiet = DEFAULT_QUIET_HOURS) {
      const from = parseTime(quiet[0]);
      const to = parseTime(quiet[1]);
      const minutes = mskMinutesOfDay(at);
      return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
    },
  };
  return clock;
}

export const systemClock: Clock = createClock(() => new Date());

export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(at: Date): void;
}

export function createFakeClock(start: Date): FakeClock {
  let current = start.getTime();
  const clock = createClock(() => new Date(current));
  return {
    ...clock,
    advance(ms) {
      current += ms;
    },
    set(at) {
      current = at.getTime();
    },
  };
}
