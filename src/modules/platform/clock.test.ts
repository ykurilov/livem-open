import { describe, expect, it } from "vitest";
import { createFakeClock, systemClock } from "./clock";

const at = (iso: string) => new Date(iso);

describe("часы", () => {
  it("системные часы отдают текущее время", () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("подменённые часы стоят на месте, пока их не сдвинули", () => {
    const clock = createFakeClock(at("2026-10-03T10:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-10-03T10:00:00.000Z");
    clock.advance(15 * 60_000);
    expect(clock.now().toISOString()).toBe("2026-10-03T10:15:00.000Z");
    clock.set(at("2026-10-04T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });

  describe("mskDate", () => {
    it("дата по Москве, а не по UTC", () => {
      const clock = createFakeClock(at("2026-10-03T21:30:00Z")); // 00:30 по Москве уже 4-го
      expect(clock.mskDate()).toBe("2026-10-04");
    });

    it("в 20:59 UTC в Москве ещё тот же день, в 21:00 уже следующий", () => {
      const clock = createFakeClock(at("2026-10-03T20:59:59Z"));
      expect(clock.mskDate()).toBe("2026-10-03");
      clock.advance(1000);
      expect(clock.mskDate()).toBe("2026-10-04");
    });

    it("принимает произвольный момент", () => {
      const clock = createFakeClock(at("2026-10-03T12:00:00Z"));
      expect(clock.mskDate(at("2026-12-31T22:00:00Z"))).toBe("2027-01-01");
    });
  });

  describe("nextMskTime", () => {
    it("ближайшее 10:00 по Москве, если сегодня оно ещё не наступило", () => {
      const clock = createFakeClock(at("2026-10-03T05:00:00Z")); // 08:00 МСК
      expect(clock.nextMskTime("10:00").toISOString()).toBe("2026-10-03T07:00:00.000Z");
    });

    it("завтрашнее 10:00, если сегодняшнее прошло", () => {
      const clock = createFakeClock(at("2026-10-03T08:00:00Z")); // 11:00 МСК
      expect(clock.nextMskTime("10:00").toISOString()).toBe("2026-10-04T07:00:00.000Z");
    });

    it("ровно в назначенное время берёт следующие сутки", () => {
      const clock = createFakeClock(at("2026-10-03T07:00:00Z")); // ровно 10:00 МСК
      expect(clock.nextMskTime("10:00").toISOString()).toBe("2026-10-04T07:00:00.000Z");
    });

    it("считает от заданного момента, а не от «сейчас»", () => {
      const clock = createFakeClock(at("2026-10-03T00:00:00Z"));
      expect(clock.nextMskTime("19:00", at("2026-10-03T17:00:00Z")).toISOString()).toBe("2026-10-04T16:00:00.000Z");
    });

    it("переход через границу месяца и года", () => {
      const clock = createFakeClock(at("2026-12-31T20:00:00Z")); // 23:00 МСК
      expect(clock.nextMskTime("09:00").toISOString()).toBe("2027-01-01T06:00:00.000Z");
    });

    it("отвергает неверный формат времени", () => {
      const clock = createFakeClock(at("2026-10-03T00:00:00Z"));
      expect(() => clock.nextMskTime("25:00")).toThrow();
      expect(() => clock.nextMskTime("девять")).toThrow();
    });
  });

  describe("isQuietHours (22:00–09:00 по Москве)", () => {
    const cases: Array<[string, string, boolean]> = [
      ["2026-10-03T18:59:00Z", "21:59 МСК", false],
      ["2026-10-03T19:00:00Z", "22:00 МСК", true],
      ["2026-10-03T21:00:00Z", "00:00 МСК", true],
      ["2026-10-04T05:59:00Z", "08:59 МСК", true],
      ["2026-10-04T06:00:00Z", "09:00 МСК", false],
      ["2026-10-04T09:00:00Z", "12:00 МСК", false],
    ];
    it.each(cases)("%s (%s) → %s", (iso, _label, expected) => {
      const clock = createFakeClock(at(iso));
      expect(clock.isQuietHours()).toBe(expected);
    });

    it("границы можно задать настройками", () => {
      const clock = createFakeClock(at("2026-10-03T17:30:00Z")); // 20:30 МСК
      expect(clock.isQuietHours(undefined, ["20:00", "21:00"])).toBe(true);
      expect(clock.isQuietHours(undefined, ["21:00", "22:00"])).toBe(false);
    });
  });
});
