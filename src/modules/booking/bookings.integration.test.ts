import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { bookCall, cancelCall, cancelBookingByExpert, currentBookingOf, freeCallTimes, listCallBookings, rescheduleCall, type CallParty } from "./bookings";
import { deleteCallWindow, saveCallWindow, updateCallCalendar } from "./calendar";

let database: TestDatabase;
const now = new Date("2026-11-19T09:00:00Z"); // чт, 12:00 по Москве

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("delete from app.call_notices; delete from app.call_bookings; delete from app.call_windows; delete from app.call_calendar");
  await updateCallCalendar(database.db, { timeZone: "Europe/Moscow", callMinutes: 30 }, { now, confirm: true });
  // пт, 20 ноября, 10:00–12:00 по Москве
  const saved = await saveCallWindow(database.db, { date: "2026-11-20", startTime: "10:00", endTime: "12:00", weekly: false }, { now, confirm: false });
  if (!saved.ok) throw new Error("Окно не сохранилось");
});

const person = (): CallParty => ({ kind: "person", personId: randomUUID(), passageId: randomUUID(), leadMagnetId: null });
const test = (): CallParty => ({ kind: "test", chatId: `preview-${randomUUID()}`, leadMagnetId: null });

describe("запись на созвон", () => {
  it("свободное время — ближайшие созвоны по поясу эксперта", async () => {
    const free = await freeCallTimes(database.db, { now });
    expect(free.timeZone).toBe("Europe/Moscow");
    expect(free.slots.map((slot) => slot.startsAt.toISOString())).toEqual([
      "2026-11-20T07:00:00.000Z",
      "2026-11-20T07:30:00.000Z",
      "2026-11-20T08:00:00.000Z",
      "2026-11-20T08:30:00.000Z",
    ]);
  });

  it("два разговора одновременно на одно время: записан один, второй получает «занято»", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => bookCall(database.db, { party: person(), localStart: "2026-11-20T10:30", now, meetingLink: null })),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map((result) => !result.ok && result.reason)).toEqual(Array(5).fill("not_free"));
    expect((await freeCallTimes(database.db, { now })).slots.map((slot) => slot.startsAt.toISOString())).not.toContain("2026-11-20T07:30:00.000Z");
  });

  it("база сама не даёт двух действующих записей на пересекающееся время", async () => {
    const insert = (start: string, end: string) =>
      database.pool.query("insert into app.call_bookings (starts_at, ends_at, person_id) values ($1, $2, $3)", [start, end, randomUUID()]);
    await insert("2026-11-20T07:00:00Z", "2026-11-20T07:30:00Z");
    await expect(insert("2026-11-20T07:15:00Z", "2026-11-20T07:45:00Z")).rejects.toMatchObject({ code: "23P01" });
    await insert("2026-11-20T07:30:00Z", "2026-11-20T08:00:00Z");
  });

  it("время вне окон, занятое или не время — отказ с причиной", async () => {
    expect(await bookCall(database.db, { party: person(), localStart: "2026-11-20T14:00", now, meetingLink: null })).toEqual({ ok: false, reason: "not_free" });
    expect(await bookCall(database.db, { party: person(), localStart: "в пятницу", now, meetingLink: null })).toEqual({ ok: false, reason: "bad_time" });
  });

  it("у человека одна запись в будущем: вторая — отказ, перенос меняет время", async () => {
    const party = person();
    const first = await bookCall(database.db, { party, localStart: "2026-11-20T10:00", now, meetingLink: "https://meet.test/x" });
    expect(first.ok).toBe(true);
    expect(await bookCall(database.db, { party, localStart: "2026-11-20T11:00", now, meetingLink: null })).toEqual({ ok: false, reason: "has_booking" });

    const moved = await rescheduleCall(database.db, { party, localStart: "2026-11-20T10:30", now });
    if (!moved.ok) throw new Error(moved.reason);
    expect(moved.previous.status).toBe("rescheduled");
    expect(moved.previous.rescheduledToId).toBe(moved.booking.id);
    expect(moved.booking.meetingLink).toBe("https://meet.test/x");
    expect((await currentBookingOf(database.db, party, now))?.startsAt.toISOString()).toBe("2026-11-20T07:30:00.000Z");
    // Прежнее время снова свободно
    expect((await freeCallTimes(database.db, { now })).slots.map((slot) => slot.startsAt.toISOString())).toContain("2026-11-20T07:00:00.000Z");
  });

  it("перенос на занятое время оставляет прежнюю запись", async () => {
    const party = person();
    await bookCall(database.db, { party, localStart: "2026-11-20T10:00", now, meetingLink: null });
    await bookCall(database.db, { party: person(), localStart: "2026-11-20T11:00", now, meetingLink: null });
    expect(await rescheduleCall(database.db, { party, localStart: "2026-11-20T11:00", now })).toEqual({ ok: false, reason: "not_free" });
    expect((await currentBookingOf(database.db, party, now))?.startsAt.toISOString()).toBe("2026-11-20T07:00:00.000Z");
  });

  it("прошедший созвон не мешает записаться снова", async () => {
    const party = person();
    await bookCall(database.db, { party, localStart: "2026-11-20T10:00", now, meetingLink: null });
    await saveCallWindow(database.db, { date: "2026-11-27", startTime: "10:00", endTime: "11:00", weekly: false }, { now, confirm: false });
    const later = new Date("2026-11-21T09:00:00Z");
    expect(await currentBookingOf(database.db, party, later)).toBeNull();
    expect((await bookCall(database.db, { party, localStart: "2026-11-27T10:00", now: later, meetingLink: null })).ok).toBe(true);
  });

  it("отмена человеком и экспертом освобождает время", async () => {
    const party = person();
    await bookCall(database.db, { party, localStart: "2026-11-20T10:00", now, meetingLink: null });
    const cancelled = await cancelCall(database.db, { party, now });
    expect(cancelled.ok && cancelled.booking).toMatchObject({ status: "cancelled", cancelledBy: "person" });
    expect(await cancelCall(database.db, { party, now })).toEqual({ ok: false, reason: "no_booking" });

    const other = await bookCall(database.db, { party: person(), localStart: "2026-11-20T10:00", now, meetingLink: null });
    if (!other.ok) throw new Error(other.reason);
    expect(await cancelBookingByExpert(database.db, other.booking.id, now)).toMatchObject({ status: "cancelled", cancelledBy: "expert" });
    expect((await freeCallTimes(database.db, { now })).slots).toHaveLength(4);
  });

  it("тестовая запись «Проверки» не занимает окно и не видна в «Записях»", async () => {
    const party = test();
    const booked = await bookCall(database.db, { party, localStart: "2026-11-20T10:00", now, meetingLink: null });
    expect(booked.ok && booked.booking.testChatId).toBe(party.kind === "test" && party.chatId);
    expect((await freeCallTimes(database.db, { now })).slots).toHaveLength(4);
    expect((await bookCall(database.db, { party: person(), localStart: "2026-11-20T10:00", now, meetingLink: null })).ok).toBe(true);
    expect((await currentBookingOf(database.db, party, now))?.id).toBe(booked.ok && booked.booking.id);
    expect((await listCallBookings(database.db, { now })).map((row) => row.testChatId)).toEqual([null]);
  });
});

describe("правка окон при существующих записях", () => {
  it("удаление окна с записью: без согласия — список записей, которые окажутся вне окон; с согласием — записи остаются", async () => {
    const [window] = (await database.pool.query("select id from app.call_windows")).rows as Array<{ id: string }>;
    await bookCall(database.db, { party: person(), localStart: "2026-11-20T11:00", now, meetingLink: null });

    const asked = await deleteCallWindow(database.db, window!.id, { now, confirm: false });
    expect(asked).toMatchObject({ ok: false, outside: [expect.objectContaining({ startsAt: new Date("2026-11-20T08:00:00Z") })] });
    expect((await freeCallTimes(database.db, { now })).slots).toHaveLength(3);

    expect(await deleteCallWindow(database.db, window!.id, { now, confirm: true })).toMatchObject({ ok: true });
    expect((await freeCallTimes(database.db, { now })).slots).toHaveLength(0);
    expect((await listCallBookings(database.db, { now })).map((row) => row.status)).toEqual(["booked"]);
  });

  it("сужение окна мимо записи спрашивает, мимо пустого времени — нет", async () => {
    const [window] = (await database.pool.query("select id from app.call_windows")).rows as Array<{ id: string }>;
    await bookCall(database.db, { party: person(), localStart: "2026-11-20T10:00", now, meetingLink: null });
    const narrowed = { id: window!.id, date: "2026-11-20", startTime: "10:00", endTime: "11:00", weekly: false };
    expect(await saveCallWindow(database.db, narrowed, { now, confirm: false })).toMatchObject({ ok: true });
    const moved = { ...narrowed, startTime: "10:30", endTime: "11:30" };
    expect(await saveCallWindow(database.db, moved, { now, confirm: false })).toMatchObject({ ok: false, outside: [expect.anything()] });
  });

  it("смена пояса эксперта сдвигает окна: записи вне новых окон показываются до сохранения", async () => {
    await bookCall(database.db, { party: person(), localStart: "2026-11-20T10:00", now, meetingLink: null });
    expect(await updateCallCalendar(database.db, { timeZone: "Asia/Novosibirsk" }, { now, confirm: false })).toMatchObject({ ok: false, outside: [expect.anything()] });
    expect(await updateCallCalendar(database.db, { callMinutes: 60 }, { now, confirm: false })).toMatchObject({ ok: true });
  });

  it("неверное окно — понятная ошибка", async () => {
    expect(await saveCallWindow(database.db, { date: "2026-11-20", startTime: "10:00", endTime: "10:00", weekly: false }, { now, confirm: false })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Начало и конец"),
    });
    expect(await saveCallWindow(database.db, { date: "20.11", startTime: "10:00", endTime: "11:00", weekly: false }, { now, confirm: false })).toMatchObject({
      ok: false,
      error: expect.any(String),
    });
  });
});

describe("одновременные действия", () => {
  /** Чужая транзакция держит правку незафиксированной, пока действие не дойдёт до неё; потом фиксируется. */
  async function whileUncommitted<T>(statements: string[], action: () => Promise<T>): Promise<T> {
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      for (const statement of statements) await client.query(statement);
      const result = action();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query("commit");
      return await result;
    } finally {
      client.release();
    }
  }

  it("эксперт отменил, пока человек переносит: отмена остаётся, новой записи нет", async () => {
    const party = person();
    const booked = await bookCall(database.db, { party, localStart: "2026-11-20T10:00", now, meetingLink: null });
    if (!booked.ok) throw new Error(booked.reason);
    const moved = await whileUncommitted([`update app.call_bookings set status = 'cancelled', cancelled_by = 'expert', cancelled_at = now() where id = '${booked.booking.id}'`], () =>
      rescheduleCall(database.db, { party, localStart: "2026-11-20T10:30", now }),
    );
    expect(moved).toEqual({ ok: false, reason: "no_booking" });
    expect((await listCallBookings(database.db, { now })).map((row) => row.status)).toEqual(["cancelled"]);
  });

  it("эксперт удаляет окно, пока человек записывается: запись не встаёт вне окон молча", async () => {
    const [window] = (await database.pool.query("select id from app.call_windows")).rows as Array<{ id: string }>;
    const booked = await whileUncommitted(["select 1 from app.call_calendar for update", `delete from app.call_windows where id = '${window!.id}'`], () =>
      bookCall(database.db, { party: person(), localStart: "2026-11-20T10:00", now, meetingLink: null }),
    );
    expect(booked).toEqual({ ok: false, reason: "not_free" });
  });
});
