import { describe, expect, it } from "vitest";
import { callSlotAt, freeCallSlots, slotLabel, timeZoneOffsetLabel, windowOccurrences, type CallWindow } from "./slots";

const MOSCOW = "Europe/Moscow";
const window = (patch: Partial<CallWindow> = {}): CallWindow => ({ id: "w1", date: "2026-11-20", startTime: "10:00", endTime: "12:00", weekly: false, ...patch });
const iso = (slots: Array<{ startsAt: Date }>) => slots.map((slot) => slot.startsAt.toISOString());

describe("окна и нарезка на созвоны", () => {
  const base = { timeZone: MOSCOW, callMinutes: 30, now: new Date("2026-11-19T09:00:00Z"), until: new Date("2026-12-31T00:00:00Z"), busy: [] };

  it("окно режется на созвоны заданной длины по поясу эксперта", () => {
    const slots = freeCallSlots({ ...base, windows: [window()] });
    expect(iso(slots)).toEqual(["2026-11-20T07:00:00.000Z", "2026-11-20T07:30:00.000Z", "2026-11-20T08:00:00.000Z", "2026-11-20T08:30:00.000Z"]);
    expect(slots[0]!.endsAt.toISOString()).toBe("2026-11-20T07:30:00.000Z");
  });

  it("хвост короче созвона не становится созвоном", () => {
    expect(iso(freeCallSlots({ ...base, callMinutes: 45, windows: [window()] }))).toEqual(["2026-11-20T07:00:00.000Z", "2026-11-20T07:45:00.000Z"]);
  });

  it("прошедшие и слишком близкие созвоны не предлагаются", () => {
    const now = new Date("2026-11-20T07:20:00Z"); // 10:20 по Москве: 10:00 прошёл, 10:30 — меньше чем через час
    expect(iso(freeCallSlots({ ...base, now, windows: [window()] }))).toEqual(["2026-11-20T08:30:00.000Z"]);
  });

  it("занятое записью время выпадает, в том числе частично перекрытое", () => {
    const busy = [{ startsAt: new Date("2026-11-20T07:15:00Z"), endsAt: new Date("2026-11-20T08:00:00Z") }];
    expect(iso(freeCallSlots({ ...base, busy, windows: [window()] }))).toEqual(["2026-11-20T08:00:00.000Z", "2026-11-20T08:30:00.000Z"]);
  });

  it("повтор каждую неделю — с даты окна и дальше, не раньше", () => {
    const until = new Date("2026-12-05T00:00:00Z");
    const slots = freeCallSlots({ ...base, until, callMinutes: 120, windows: [window({ weekly: true })] });
    expect(iso(slots)).toEqual(["2026-11-20T07:00:00.000Z", "2026-11-27T07:00:00.000Z", "2026-12-04T07:00:00.000Z"]);
  });

  it("повтор, начатый давно, даёт ближайшие недели", () => {
    const occurrences = windowOccurrences(window({ date: "2025-01-03", weekly: true }), MOSCOW, base.now, new Date("2026-11-28T00:00:00Z"));
    expect(iso(occurrences)).toEqual(["2026-11-20T07:00:00.000Z", "2026-11-27T07:00:00.000Z"]);
  });

  it("окно через полночь: конец раньше начала — значит, назавтра", () => {
    const slots = freeCallSlots({ ...base, callMinutes: 60, windows: [window({ startTime: "23:00", endTime: "01:00" })] });
    expect(iso(slots)).toEqual(["2026-11-20T20:00:00.000Z", "2026-11-20T21:00:00.000Z"]);
  });

  it("смена летнего времени: повтор остаётся в 10:00 по местным часам", () => {
    const berlin = "Europe/Berlin";
    const occurrences = windowOccurrences(window({ date: "2026-10-18", weekly: true }), berlin, new Date("2026-10-17T00:00:00Z"), new Date("2026-10-26T00:00:00Z"));
    expect(iso(occurrences)).toEqual(["2026-10-18T08:00:00.000Z", "2026-10-25T09:00:00.000Z"]);
  });

  it("перекрытые окна не дают одно время дважды", () => {
    const slots = freeCallSlots({ ...base, windows: [window(), window({ id: "w2", startTime: "11:00", endTime: "13:00" })] });
    expect(iso(slots)).toEqual([
      "2026-11-20T07:00:00.000Z",
      "2026-11-20T07:30:00.000Z",
      "2026-11-20T08:00:00.000Z",
      "2026-11-20T08:30:00.000Z",
      "2026-11-20T09:00:00.000Z",
      "2026-11-20T09:30:00.000Z",
    ]);
  });

  it("время по местным часам эксперта находит свободный созвон, занятое и вне окон — нет", () => {
    const input = { ...base, windows: [window()] };
    expect(callSlotAt(input, "2026-11-20T10:30")?.startsAt.toISOString()).toBe("2026-11-20T07:30:00.000Z");
    expect(callSlotAt(input, "2026-11-20T10:15")).toBeNull();
    expect(callSlotAt(input, "2026-11-20T13:00")).toBeNull();
    expect(callSlotAt({ ...input, busy: [{ startsAt: new Date("2026-11-20T07:30:00Z"), endsAt: new Date("2026-11-20T08:00:00Z") }] }, "2026-11-20T10:30")).toBeNull();
    expect(callSlotAt(input, "завтра")).toBeNull();
  });

  it("подпись созвона — день, время и смещение пояса", () => {
    const slot = { startsAt: new Date("2026-11-20T07:00:00Z"), endsAt: new Date("2026-11-20T07:30:00Z") };
    expect(slotLabel(slot, MOSCOW)).toBe("пт, 20 ноября, 10:00–10:30 (UTC+3)");
    expect(timeZoneOffsetLabel("Asia/Kolkata", slot.startsAt)).toBe("UTC+5:30");
    expect(timeZoneOffsetLabel("UTC", slot.startsAt)).toBe("UTC");
  });
});
