// Календарь программы: день считается по поясу человека, пока он неизвестен — по Москве
import { describe, expect, it } from "vitest";
import {
  atLocalTime,
  dayStartsAt,
  isValidTimeZone,
  localDate,
  localTime,
  nextLocalTime,
  programDay,
  programStartDate,
  resolveTimeZone,
  termEndsAt,
} from "./calendar";

const MOSCOW = "Europe/Moscow";
const NOVOSIBIRSK = "Asia/Novosibirsk";
const KALININGRAD = "Europe/Kaliningrad";

/** Момент по Москве (UTC+3): `msk("2026-10-12 14:00")`. */
const msk = (value: string) => new Date(`${value.replace(" ", "T")}:00+03:00`);
const nsk = (value: string) => new Date(`${value.replace(" ", "T")}:00+07:00`);

describe("пояс человека", () => {
  it("неизвестный, пустой или выдуманный пояс — Москва", () => {
    expect(resolveTimeZone(null)).toBe(MOSCOW);
    expect(resolveTimeZone(undefined)).toBe(MOSCOW);
    expect(resolveTimeZone("")).toBe(MOSCOW);
    expect(resolveTimeZone("Нарния/Лампа")).toBe(MOSCOW);
    expect(resolveTimeZone(NOVOSIBIRSK)).toBe(NOVOSIBIRSK);
  });

  it("isValidTimeZone узнаёт только настоящие пояса IANA", () => {
    expect(isValidTimeZone(NOVOSIBIRSK)).toBe(true);
    expect(isValidTimeZone("Europe/Kaliningrad")).toBe(true);
    expect(isValidTimeZone("Нарния/Лампа")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("дата и время по поясу", () => {
  it("localDate и localTime: один и тот же момент в разных поясах", () => {
    const at = new Date("2026-10-12T20:30:00Z"); // 23:30 по Москве, 03:30 следующих суток в Новосибирске
    expect(localDate(at, MOSCOW)).toBe("2026-10-12");
    expect(localTime(at, MOSCOW)).toBe("23:30");
    expect(localDate(at, NOVOSIBIRSK)).toBe("2026-10-13");
    expect(localTime(at, NOVOSIBIRSK)).toBe("03:30");
    expect(localTime(at, KALININGRAD)).toBe("22:30");
  });

  it("полночь пишется как 00:00, а не 24:00", () => {
    expect(localTime(msk("2026-10-13 00:00"), MOSCOW)).toBe("00:00");
  });

  it("atLocalTime: настенное время даты в поясе — момент времени", () => {
    expect(atLocalTime("2026-10-13", "10:00", MOSCOW)).toEqual(msk("2026-10-13 10:00"));
    expect(atLocalTime("2026-10-13", "10:00", NOVOSIBIRSK)).toEqual(nsk("2026-10-13 10:00"));
    expect(atLocalTime("2026-10-13", "05:00", KALININGRAD)).toEqual(new Date("2026-10-13T05:00:00+02:00"));
  });

  it("atLocalTime переживает переход на зимнее время (Берлин, 25 октября 2026)", () => {
    expect(atLocalTime("2026-10-24", "05:00", "Europe/Berlin")).toEqual(new Date("2026-10-24T05:00:00+02:00"));
    expect(atLocalTime("2026-10-25", "05:00", "Europe/Berlin")).toEqual(new Date("2026-10-25T05:00:00+01:00"));
  });

  it("nextLocalTime: ближайший строго следующий момент с таким временем", () => {
    expect(nextLocalTime("10:00", msk("2026-10-12 09:00"), MOSCOW)).toEqual(msk("2026-10-12 10:00"));
    expect(nextLocalTime("10:00", msk("2026-10-12 10:00"), MOSCOW)).toEqual(msk("2026-10-13 10:00"));
    expect(nextLocalTime("10:00", msk("2026-10-12 23:59"), MOSCOW)).toEqual(msk("2026-10-13 10:00"));
    // В Новосибирске в этот момент уже 13:00 — десять утра будет завтра
    expect(nextLocalTime("10:00", msk("2026-10-12 09:00"), NOVOSIBIRSK)).toEqual(nsk("2026-10-13 10:00"));
  });

  it("плохое время — понятная ошибка", () => {
    expect(() => atLocalTime("2026-10-13", "25:00", MOSCOW)).toThrow(/ЧЧ:ММ/);
    expect(() => nextLocalTime("10", msk("2026-10-12 09:00"), MOSCOW)).toThrow(/ЧЧ:ММ/);
  });
});

describe("день программы", () => {
  it("первое сообщение 12-го в 14:00 — день 1, день 2 начинается 13-го в 5:00 (сценарий 1)", () => {
    const startDate = programStartDate(msk("2026-10-12 14:00"), MOSCOW);
    expect(startDate).toBe("2026-10-12");
    expect(programDay({ startDate, now: msk("2026-10-12 14:00"), timeZone: MOSCOW })).toBe(1);
    expect(programDay({ startDate, now: msk("2026-10-13 04:59"), timeZone: MOSCOW })).toBe(1);
    expect(programDay({ startDate, now: msk("2026-10-13 05:00"), timeZone: MOSCOW })).toBe(2);
    expect(dayStartsAt(startDate, 2, MOSCOW)).toEqual(msk("2026-10-13 05:00"));
  });

  it("день меняется в 5:00, а не в полночь: в 2:00 ещё прошлый день программы", () => {
    const startDate = "2026-10-12";
    expect(programDay({ startDate, now: msk("2026-10-14 02:00"), timeZone: MOSCOW })).toBe(2);
    expect(programDay({ startDate, now: msk("2026-10-14 04:59"), timeZone: MOSCOW })).toBe(2);
    expect(programDay({ startDate, now: msk("2026-10-14 05:00"), timeZone: MOSCOW })).toBe(3);
  });

  it("ночной старт: день 1 — календарный день первого сообщения, день 2 начнётся в 5:00 следующих суток", () => {
    const startedAt = msk("2026-10-13 02:00");
    const startDate = programStartDate(startedAt, MOSCOW);
    expect(startDate).toBe("2026-10-13");
    expect(programDay({ startDate, now: startedAt, timeZone: MOSCOW })).toBe(1);
    expect(programDay({ startDate, now: msk("2026-10-13 05:00"), timeZone: MOSCOW })).toBe(1);
    expect(programDay({ startDate, now: msk("2026-10-14 04:59"), timeZone: MOSCOW })).toBe(1);
    expect(programDay({ startDate, now: msk("2026-10-14 05:00"), timeZone: MOSCOW })).toBe(2);
    expect(dayStartsAt(startDate, 2, MOSCOW)).toEqual(msk("2026-10-14 05:00"));
  });

  it("день 1 начинается с полуночи календарной даты", () => {
    expect(dayStartsAt("2026-10-12", 1, MOSCOW)).toEqual(msk("2026-10-12 00:00"));
  });

  it("Новосибирск: дата старта и границы дней считаются по его времени", () => {
    const startedAt = new Date("2026-10-12T20:30:00Z"); // 23:30 по Москве, 03:30 13-го в Новосибирске
    expect(programStartDate(startedAt, MOSCOW)).toBe("2026-10-12");
    const startDate = programStartDate(startedAt, NOVOSIBIRSK);
    expect(startDate).toBe("2026-10-13");
    expect(programDay({ startDate, now: startedAt, timeZone: NOVOSIBIRSK })).toBe(1);
    expect(dayStartsAt(startDate, 2, NOVOSIBIRSK)).toEqual(nsk("2026-10-14 05:00"));
    expect(programDay({ startDate, now: nsk("2026-10-14 04:59"), timeZone: NOVOSIBIRSK })).toBe(1);
    expect(programDay({ startDate, now: nsk("2026-10-14 05:00"), timeZone: NOVOSIBIRSK })).toBe(2);
  });

  it("Калининград: 5:00 по его времени — это 6:00 по Москве", () => {
    const startDate = "2026-10-12";
    expect(dayStartsAt(startDate, 2, KALININGRAD)).toEqual(msk("2026-10-13 06:00"));
    expect(programDay({ startDate, now: msk("2026-10-13 05:59"), timeZone: KALININGRAD })).toBe(1);
    expect(programDay({ startDate, now: msk("2026-10-13 06:00"), timeZone: KALININGRAD })).toBe(2);
  });

  it("пояс узнан посреди программы: номер дня считается по новому поясу, дата старта остаётся", () => {
    const startDate = "2026-10-12";
    const now = msk("2026-10-13 03:30"); // в Москве ещё ночь дня 1, в Новосибирске уже 07:30 дня 2
    expect(programDay({ startDate, now, timeZone: MOSCOW })).toBe(1);
    expect(programDay({ startDate, now, timeZone: NOVOSIBIRSK })).toBe(2);
    // пока пояса нет — Москва
    expect(programDay({ startDate, now, timeZone: null })).toBe(1);
  });

  it("день не бывает меньше 1, даже если «сейчас» раньше даты старта", () => {
    expect(programDay({ startDate: "2026-10-13", now: msk("2026-10-12 12:00"), timeZone: MOSCOW })).toBe(1);
  });

  it("переход на зимнее время не сдвигает границу дня: всегда 5:00 по настенным часам", () => {
    const berlin = "Europe/Berlin";
    const startDate = "2026-10-24";
    expect(dayStartsAt(startDate, 2, berlin)).toEqual(new Date("2026-10-25T05:00:00+01:00"));
    expect(programDay({ startDate, now: new Date("2026-10-25T04:59:00+01:00"), timeZone: berlin })).toBe(1);
    expect(programDay({ startDate, now: new Date("2026-10-25T05:00:00+01:00"), timeZone: berlin })).toBe(2);
  });

  it("конец срока — 5:00 после последнего дня", () => {
    expect(termEndsAt("2026-10-12", 3, MOSCOW)).toEqual(msk("2026-10-15 05:00"));
    expect(termEndsAt("2026-10-12", 3, NOVOSIBIRSK)).toEqual(nsk("2026-10-15 05:00"));
    expect(termEndsAt("2026-10-30", 3, MOSCOW)).toEqual(msk("2026-11-02 05:00"));
    // совпадает с началом следующего, несуществующего дня
    expect(termEndsAt("2026-10-12", 3, MOSCOW)).toEqual(dayStartsAt("2026-10-12", 4, MOSCOW));
  });
});
