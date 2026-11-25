import { describe, expect, it } from "vitest";
import { MAX_REWIND_MS, MIN_REWIND_MS, parseRewindDuration } from "./rewind-duration";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ms = (text: string) => {
  const result = parseRewindDuration(text);
  if (!result.ok) throw new Error(`«${text}» не разобралось: ${result.hint}`);
  return result.ms;
};

describe("разбор времени перемотки", () => {
  it("минуты, часы и дни в разных написаниях", () => {
    expect(ms("45 мин")).toBe(45 * MIN);
    expect(ms("45м")).toBe(45 * MIN);
    expect(ms("15 минут")).toBe(15 * MIN);
    expect(ms("1 ч")).toBe(HOUR);
    expect(ms("3 часа")).toBe(3 * HOUR);
    expect(ms("5 часов")).toBe(5 * HOUR);
    expect(ms("1 час")).toBe(HOUR);
    expect(ms("2 дня")).toBe(2 * DAY);
    expect(ms("1 д")).toBe(DAY);
    expect(ms("3 дн")).toBe(3 * DAY);
    expect(ms("5 дней")).toBe(5 * DAY);
  });

  it("части складываются; пробелы, запятые и регистр не мешают", () => {
    expect(ms("1 ч 30 мин")).toBe(HOUR + 30 * MIN);
    expect(ms("1ч30м")).toBe(HOUR + 30 * MIN);
    expect(ms("  2 дня,  3 часа ,15 мин ")).toBe(2 * DAY + 3 * HOUR + 15 * MIN);
    expect(ms("1 Ч 30 МИН")).toBe(HOUR + 30 * MIN);
  });

  it("дробное число: «1,5 ч» и «1.5 ч» — полтора часа", () => {
    expect(ms("1,5 ч")).toBe(90 * MIN);
    expect(ms("0.5 ч")).toBe(30 * MIN);
  });

  it("недели, месяцы и год: неделя — 7 суток, месяц — 30, год — 365", () => {
    expect(ms("1 неделя")).toBe(7 * DAY);
    expect(ms("2 недели")).toBe(14 * DAY);
    expect(ms("3 нед")).toBe(21 * DAY);
    expect(ms("1 месяц")).toBe(30 * DAY);
    expect(ms("2 месяца")).toBe(60 * DAY);
    expect(ms("6 месяцев")).toBe(180 * DAY);
    expect(ms("1 мес")).toBe(30 * DAY);
    expect(ms("1 год")).toBe(365 * DAY);
    expect(ms("1 месяц 2 недели")).toBe(44 * DAY);
  });

  it("пределы: от минуты до года включительно", () => {
    expect(MIN_REWIND_MS).toBe(MIN);
    expect(MAX_REWIND_MS).toBe(365 * DAY);
    expect(ms("1 мин")).toBe(MIN);
    expect(ms("365 дней")).toBe(365 * DAY);
    for (const text of ["366 дней", "1 год 1 мин", "5 лет", "13 месяцев", "0,5 мин"]) {
      const result = parseRewindDuration(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.hint, text).toMatch(/от минуты до года/);
    }
  });

  it("мусор и число без единицы — подсказка с примерами", () => {
    for (const text of ["", "   ", "0 мин", "скоро", "45", "мин 45", "-5 мин", "5 веков", "1 ч ч"]) {
      const result = parseRewindDuration(text);
      expect(result.ok, `«${text}»`).toBe(false);
      if (!result.ok) expect(result.hint, `«${text}»`).toMatch(/45 мин.*1 ч 30 мин.*2 дня/);
    }
  });
});
