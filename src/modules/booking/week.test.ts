import { describe, expect, it } from "vitest";
import { callWeek, weekStartOf } from "./week";

const ZONE = "Europe/Moscow";

describe("неделя календаря созвонов", () => {
  it("неделя начинается с понедельника по часам эксперта", () => {
    expect(weekStartOf("2026-11-19")).toBe("2026-11-16");
    expect(weekStartOf("2026-11-16")).toBe("2026-11-16");
    expect(weekStartOf("2026-11-22")).toBe("2026-11-16");
  });

  it("окна раскладываются по дням недели, повторяющееся — в каждую неделю; записи — в свой день, отменённые не видны", () => {
    const week = callWeek({
      weekStart: "2026-11-16",
      timeZone: ZONE,
      now: new Date("2026-11-19T09:00:00Z"),
      windows: [
        { id: "once", date: "2026-11-20", startTime: "10:00", endTime: "12:00", weekly: false },
        { id: "weekly", date: "2026-11-02", startTime: "18:00", endTime: "19:00", weekly: true },
        { id: "next-week", date: "2026-11-24", startTime: "10:00", endTime: "11:00", weekly: false },
      ],
      bookings: [
        { id: "b1", startsAt: new Date("2026-11-20T07:00:00Z"), endsAt: new Date("2026-11-20T07:30:00Z"), status: "booked", personName: "Анна", personId: "p1" },
        { id: "b2", startsAt: new Date("2026-11-20T07:30:00Z"), endsAt: new Date("2026-11-20T08:00:00Z"), status: "cancelled", personName: "Борис", personId: "p2" },
      ],
    });
    expect(week.days.map((day) => day.date)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]);
    expect(week.days[0]!.windows.map((window) => [window.id, window.time])).toEqual([["weekly", "18:00–19:00"]]);
    expect(week.days[4]!.windows.map((window) => window.id)).toEqual(["once"]);
    expect(week.days[4]!.bookings.map((booking) => [booking.id, booking.time])).toEqual([["b1", "10:00–10:30"]]);
    expect(week.days.flatMap((day) => day.windows).some((window) => window.id === "next-week")).toBe(false);
    expect(week.days[0]!.past).toBe(true);
    expect(week.days[3]!.past).toBe(false);
    expect(week.previousWeek).toBe("2026-11-09");
    expect(week.nextWeek).toBe("2026-11-23");
  });

  it("окно через полночь показано в день начала", () => {
    const week = callWeek({
      weekStart: "2026-11-16",
      timeZone: ZONE,
      now: new Date("2026-11-16T00:00:00Z"),
      windows: [{ id: "night", date: "2026-11-18", startTime: "23:00", endTime: "01:00", weekly: false }],
      bookings: [],
    });
    expect(week.days[2]!.windows.map((window) => window.time)).toEqual(["23:00–01:00"]);
    expect(week.days[3]!.windows).toEqual([]);
  });
});
