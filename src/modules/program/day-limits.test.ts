// Рамки дня: мягкая включает прощание до завтра, жёсткая — «продолжим утром»
import { describe, expect, it } from "vitest";
import { dayLimitState } from "./day-limits";

const limits = { softDailyMessages: 20, hardDailyMessages: 30 };

describe("рамки дня", () => {
  it("до мягкой рамки — обычный разговор", () => {
    expect(dayLimitState(1, limits)).toBe("normal");
    expect(dayLimitState(19, limits)).toBe("normal");
  });

  it("20-е сообщение за день — консультант начинает по-доброму прощаться до завтра", () => {
    expect(dayLimitState(20, limits)).toBe("soft");
    expect(dayLimitState(29, limits)).toBe("soft");
  });

  it("30-е сообщение — последнее прощание до утра", () => {
    expect(dayLimitState(30, limits)).toBe("last");
  });

  it("после жёсткой рамки консультант не вызывается", () => {
    expect(dayLimitState(31, limits)).toBe("closed");
    expect(dayLimitState(100, limits)).toBe("closed");
  });

  it("рамки берутся из настроек, а не из кода", () => {
    const custom = { softDailyMessages: 2, hardDailyMessages: 3 };
    expect(dayLimitState(1, custom)).toBe("normal");
    expect(dayLimitState(2, custom)).toBe("soft");
    expect(dayLimitState(3, custom)).toBe("last");
    expect(dayLimitState(4, custom)).toBe("closed");
  });
});
