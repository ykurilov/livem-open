// Дни программы. Срок в «Продажу» — таймер SDK «наступил день N программы» (`{ type: "timer", from: "program_day" }`,
// SDK 0.55). До него приложение подавало событие `program_day_N` в начале хода: такие сценарии переписываются на таймер
// (`withProgramDayTimers`).

export const PROGRAM_MIN_DAYS = 2;
export const PROGRAM_MAX_DAYS = 14;

const LEGACY_PROGRAM_DAY_EVENT_PREFIX = "program_day_";

/** День из имени старого события `program_day_N`; не событие дня — `null`. */
export function legacyProgramDayOfEvent(name: string | undefined): number | null {
  if (!name?.startsWith(LEGACY_PROGRAM_DAY_EVENT_PREFIX)) return null;
  const day = Number(name.slice(LEGACY_PROGRAM_DAY_EVENT_PREFIX.length));
  return Number.isInteger(day) && day >= 1 ? day : null;
}
