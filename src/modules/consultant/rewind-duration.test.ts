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

  it("пределы: от минуты до 30 суток включительно", () => {
    expect(MIN_REWIND_MS).toBe(MIN);
    expect(MAX_REWIND_MS).toBe(30 * DAY);
    expect(ms("1 мин")).toBe(MIN);
    expect(ms("30 дней")).toBe(30 * DAY);
    for (const text of ["31 день", "720 ч 1 мин", "0,5 мин"]) {
      const result = parseRewindDuration(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.hint, text).toMatch(/от минуты до 30 суток/);
    }
  });

  it("мусор и число без единицы — подсказка с примерами", () => {
    for (const text of ["", "   ", "0 мин", "скоро", "45", "мин 45", "-5 мин", "5 лет", "1 ч ч"]) {
      const result = parseRewindDuration(text);
      expect(result.ok, `«${text}»`).toBe(false);
      if (!result.ok) expect(result.hint, `«${text}»`).toMatch(/45 мин.*1 ч 30 мин.*2 дня/);
    }
  });
});
