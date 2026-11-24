import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, DEFAULT_CONSULTANT_REPLY, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import type { ScriptedCall } from "../platform/scripted-model";
import { bots } from "../channels/schema";
import { listCallBookings } from "./bookings";
import { cancelCallByExpert } from "./cabinet";
import { saveCallWindow, updateCallCalendar } from "./calendar";
import { CALL_NOTICE_CONNECTED_TEXT, disconnectCallNoticeBot, listCallNoticeBots, queueCallNotices, startCallNoticeConnect } from "./notices";
import { CALL_BOOKED_EVENT } from "./setting";

const EXPERT = "expert-account";
const PERSON = "person-1";
const LINK = "https://meet.test/expert";

let database: TestDatabase;
let kit: LiveDialogKit;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

const toolOutput = (call: ScriptedCall) => (call.lastToolResult as { value?: { slots?: Array<{ start: string }> } } | undefined)?.value;

/** Модель записывает на первое свободное время, переносит на второе и отменяет — по словам человека. */
function bookingReply(call: ScriptedCall) {
  const text = call.lastUserText;
  if (!call.toolNames.includes("book_call")) return { text: DEFAULT_CONSULTANT_REPLY };
  if (text.includes("отмените")) return call.lastToolResult === undefined ? { toolCalls: [{ toolName: "change_call", input: { action: "cancel" } }] } : { text: "Отменил." };
  if (!text.includes("созвон") && !text.includes("перенесите")) return { text: DEFAULT_CONSULTANT_REPLY };
  if (call.lastToolResult === undefined) return { toolCalls: [{ toolName: "call_free_times", input: {} }] };
  const slots = toolOutput(call)?.slots;
  if (!slots) return { text: "Готово." };
  return text.includes("перенесите")
    ? // Своё время в свободных не значится: первое свободное — уже другое
      { toolCalls: [{ toolName: "change_call", input: { action: "reschedule", start: slots[0]!.start } }] }
    : { toolCalls: [{ toolName: "book_call", input: { start: slots[0]!.start } }] };
}

async function connectExpert() {
  const { link } = await startCallNoticeConnect(kit.db, kit.dialogAdapters, kit.bot.id);
  const code = new URL(link).searchParams.get("start")!;
  await kit.send(EXPERT, `/start ${code}`, { startCode: code });
  await kit.runDue();
}

async function publishWithBooking() {
  return kit.publish(
    {
      stages: [
        { id: "start", name: "Знакомство", instruction: "Узнай задачу.", transitionCondition: "", startDay: null, isSale: false },
        { id: "booked", name: "Записан", instruction: "Человек записан.", transitionCondition: "", startDay: null, isSale: false },
      ],
      callBooking: { enabled: true, when: "Когда человек хочет обсудить задачу", about: "", meetingLink: LINK },
    },
    (flow) => ({
      ...flow,
      states: flow.states.map((state) =>
        state.id === "start" ? { ...state, exits: [...state.exits, { id: "start_booked", when: { type: "event", event: "app", name: CALL_BOOKED_EVENT }, to: "booked" }] } : state,
      ),
    }) as typeof flow,
  );
}

const textsToExpert = () => kit.textsTo(EXPERT);
const MINUTE_MS = 60_000;
const reminderTexts = () => kit.textsTo(PERSON).filter((text) => text.startsWith("Напоминаю"));

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await database.pool.query("delete from app.call_notices; delete from app.call_notify_bots; delete from app.call_bookings; delete from app.call_windows; delete from app.call_calendar");
  kit = await createLiveDialogKit(database, { start: new Date("2026-11-19T09:00:00Z") });
  kit.reply = bookingReply;
  const now = kit.clock.now();
  await updateCallCalendar(kit.db, { timeZone: "Europe/Moscow", callMinutes: 30 }, { now, confirm: true });
  // пт, 20 ноября, 10:00–12:00 по Москве
  await saveCallWindow(kit.db, { date: "2026-11-20", startTime: "10:00", endTime: "12:00", weekly: false }, { now, confirm: true });
});

describe("уведомления эксперту через его бота", () => {
  it("«Старт» по ссылке «Подключить» привязывает аккаунт эксперта: он не становится человеком, ссылка одноразовая", async () => {
    expect((await listCallNoticeBots(kit.db)).find((bot) => bot.botId === kit.bot.id)?.state).toBe("off");
    const { link } = await startCallNoticeConnect(kit.db, kit.dialogAdapters, kit.bot.id);
    expect((await listCallNoticeBots(kit.db)).find((bot) => bot.botId === kit.bot.id)?.state).toBe("waiting");
    const code = new URL(link).searchParams.get("start")!;
    await kit.send(EXPERT, `/start ${code}`, { startCode: code });
    await kit.runDue();

    expect(textsToExpert()).toEqual([CALL_NOTICE_CONNECTED_TEXT]);
    expect(await kit.personOf(EXPERT)).toBeUndefined();
    expect((await listCallNoticeBots(kit.db)).find((bot) => bot.botId === kit.bot.id)?.state).toBe("connected");

    // Второй раз тот же код — уже не подключение
    await kit.send("someone-else", `/start ${code}`, { startCode: code });
    await kit.runDue();
    expect(kit.textsTo("someone-else")).not.toContain(CALL_NOTICE_CONNECTED_TEXT);
  });

  it("запись в разговоре: событие сценария, уведомление эксперту, напоминание человеку за час со ссылкой", async () => {
    await connectExpert();
    const { code, leadMagnetId } = await publishWithBooking();
    await kit.send(PERSON, "/start", { startCode: code });
    await kit.drain();
    await kit.send(PERSON, "Хочу на созвон");
    await kit.runDue();

    const [booking] = await listCallBookings(kit.db, { now: kit.clock.now() });
    expect(booking).toMatchObject({ status: "booked", leadMagnetId, meetingLink: LINK, personId: (await kit.personOf(PERSON))!.id, testChatId: null });
    expect(booking!.startsAt.toISOString()).toBe("2026-11-20T07:00:00.000Z");
    expect(textsToExpert().at(-1)).toMatch(/Новая запись на созвон: Человек person-1, пт, 20 ноября, 10:00–10:30 \(UTC\+3\)/);

    // Событие «записался» — переход в начале следующего хода
    await kit.send(PERSON, "Спасибо");
    await kit.runDue();
    const [passage] = await kit.passagesOf(PERSON);
    expect((await kit.dialog.flow.readRun(passage!.personId, passage!.chatId))?.state).toBe("booked");

    // Часы — к напоминанию: за час до созвона, один раз
    const before = kit.textsTo(PERSON).length;
    kit.clock.set(new Date("2026-11-20T05:59:00Z"));
    await kit.runDue();
    expect(kit.textsTo(PERSON)).toHaveLength(before);
    await kit.drain();
    const reminders = kit.textsTo(PERSON).slice(before);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain("10:00 (UTC+3)");
    expect(reminders[0]).toContain(LINK);
    // Напоминание о созвоне — служебное сообщение бота: дневной потолок сообщений первым у сценария оно не тратит
    const { rows } = await database.pool.query("select kind from app.outbound_messages where text like 'Напоминаю%'");
    expect(rows).toEqual([{ kind: "system" }]);
  });

  it("перенос и отмена человеком — уведомления эксперту; напоминание только о действующей записи", async () => {
    await connectExpert();
    const { code } = await publishWithBooking();
    await kit.send(PERSON, "/start", { startCode: code });
    await kit.drain();
    await kit.send(PERSON, "Хочу на созвон");
    await kit.runDue();
    await kit.send(PERSON, "перенесите, пожалуйста");
    await kit.runDue();
    expect(textsToExpert().at(-1)).toMatch(/Перенос созвона: .*было пт, 20 ноября, 10:00–10:30.*стало пт, 20 ноября, 10:30–11:00/);

    await kit.send(PERSON, "отмените созвон");
    await kit.runDue();
    expect(textsToExpert().at(-1)).toMatch(/Отмена созвона: .*10:30–11:00/);

    const before = kit.textsTo(PERSON).length;
    await kit.drain();
    expect(kit.textsTo(PERSON).slice(before).filter((text) => text.includes("Напоминаю"))).toEqual([]);
  });

  it("отмена экспертом — уведомление с пометкой; отключённый или удалённый бот не шлёт", async () => {
    await connectExpert();
    const { code } = await publishWithBooking();
    await kit.send(PERSON, "/start", { startCode: code });
    await kit.drain();
    await kit.send(PERSON, "Хочу на созвон");
    await kit.runDue();
    const [booking] = await listCallBookings(kit.db, { now: kit.clock.now() });

    expect(await cancelCallByExpert({ db: kit.db, queue: kit.queue, clock: kit.clock }, booking!.id, { tellPerson: false })).toBe(true);
    await kit.runDue();
    expect(textsToExpert().at(-1)).toContain("(отменили вы)");
    // Второй раз отменять нечего
    expect(await cancelCallByExpert({ db: kit.db, queue: kit.queue, clock: kit.clock }, booking!.id, { tellPerson: false })).toBe(false);
    const cancelled = (await listCallBookings(kit.db, { now: kit.clock.now() })).find((row) => row.id === booking!.id)!;

    const sentBefore = textsToExpert().length;
    await disconnectCallNoticeBot(kit.db, kit.bot.id);
    await queueCallNotices({ db: kit.db, queue: kit.queue, clock: kit.clock }, { kind: "booked", booking: cancelled! });
    await kit.runDue();
    expect(textsToExpert()).toHaveLength(sentBefore);

    await connectExpert();
    await kit.db.update(bots).set({ deletedAt: kit.clock.now() }).where(eq(bots.id, kit.bot.id));
    await queueCallNotices({ db: kit.db, queue: kit.queue, clock: kit.clock }, { kind: "rescheduled", booking: cancelled!, previous: cancelled! });
    await kit.runDue();
    expect(textsToExpert().filter((text) => text.startsWith("Перенос"))).toEqual([]);
  });

  it("эксперт остановил бота — уведомление не дошло, в блоке видно, что подключить заново", async () => {
    await connectExpert();
    kit.channel.blockUser(EXPERT);
    const { code } = await publishWithBooking();
    await kit.send(PERSON, "/start", { startCode: code });
    await kit.drain();
    await kit.send(PERSON, "Хочу на созвон");
    await kit.runDue();
    const { rows } = await database.pool.query("select status from app.call_notices");
    expect(rows).toEqual([{ status: "failed" }]);
    expect((await listCallNoticeBots(kit.db)).find((bot) => bot.botId === kit.bot.id)?.failure).toMatch(/Подключить/);
  });
});

describe("последствия записи не теряются", () => {
  async function startDialog() {
    await connectExpert();
    const { code } = await publishWithBooking();
    await kit.send(PERSON, "/start", { startCode: code });
    await kit.drain();
  }

  async function sweepLater() {
    kit.clock.set(new Date(kit.clock.now().getTime() + 2 * MINUTE_MS));
    await kit.dialog.sweepStuck();
    await kit.runDue();
  }

  it("событие сценария упало — эксперт всё равно получает уведомление, человек — напоминание", async () => {
    await startDialog();
    vi.spyOn(kit.dialog.flow, "signal").mockRejectedValue(new Error("Сценарий недоступен"));
    await kit.send(PERSON, "Хочу на созвон");
    await kit.runDue();
    expect(textsToExpert().at(-1)).toMatch(/^Новая запись на созвон/);

    kit.clock.set(new Date("2026-11-20T06:00:00Z"));
    await kit.drain();
    expect(reminderTexts()).toHaveLength(1);
  });

  it("очередь упала в момент записи — подмётчик доводит уведомление эксперту и напоминание человеку", async () => {
    await startDialog();
    const enqueue = kit.queue.enqueue.bind(kit.queue);
    vi.spyOn(kit.queue, "enqueue").mockImplementation((async (name, payload, options) => {
      if (name === "call-notice-send" || name === "call-reminder") throw new Error("Очередь недоступна");
      return enqueue(name, payload, options);
    }) as typeof kit.queue.enqueue);
    await kit.send(PERSON, "Хочу на созвон");
    await kit.runDue();
    expect(textsToExpert().filter((text) => text.startsWith("Новая запись"))).toEqual([]);
    vi.restoreAllMocks();

    await sweepLater();
    expect(textsToExpert().filter((text) => text.startsWith("Новая запись"))).toHaveLength(1);
    // Повторный проход ничего не задваивает
    await sweepLater();
    expect(textsToExpert().filter((text) => text.startsWith("Новая запись"))).toHaveLength(1);

    // Задачи напоминания нет: подмётчик ставит его, когда подошло время
    kit.clock.set(new Date("2026-11-20T06:00:00Z"));
    await sweepLater();
    await kit.drain();
    expect(reminderTexts()).toHaveLength(1);
    await sweepLater();
    expect(reminderTexts()).toHaveLength(1);
  });

  it("мессенджер не дал написать первым — напоминание не ушло, эксперт узнаёт об этом в боте и в «Записях»", async () => {
    await startDialog();
    await kit.send(PERSON, "Хочу на созвон");
    await kit.runDue();

    kit.clock.set(new Date("2026-11-20T06:00:00Z"));
    kit.channel.failNext({ ok: false, reason: "reply_window_closed" });
    await kit.drain();
    expect(reminderTexts()).toEqual([]);

    await sweepLater();
    const notices = textsToExpert().filter((text) => text.startsWith("Напоминание о созвоне не дошло"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/Человек person-1, пт, 20 ноября, 10:00–10:30/);
    expect(notices[0]).toMatch(/не даёт боту писать первым/);
    await sweepLater();
    expect(textsToExpert().filter((text) => text.startsWith("Напоминание о созвоне не дошло"))).toHaveLength(1);

    const [booking] = await listCallBookings(kit.db, { now: kit.clock.now() });
    expect(booking!.reminderFailure).toMatch(/не даёт боту писать первым/);
  });
});

describe("отмена экспертом — сообщение человеку", () => {
  const cabinet = () => ({ db: kit.db, queue: kit.queue, clock: kit.clock });
  const activeBooking = async () => (await listCallBookings(kit.db, { now: kit.clock.now() })).find((row) => row.status === "booked")!;

  async function bookInDialog() {
    await connectExpert();
    const { code } = await publishWithBooking();
    await kit.send(PERSON, "/start", { startCode: code });
    await kit.drain();
    await kit.send(PERSON, "Хочу на созвон");
    await kit.runDue();
    return activeBooking();
  }

  async function sweepLater() {
    kit.clock.set(new Date(kit.clock.now().getTime() + 2 * MINUTE_MS));
    await kit.dialog.sweepStuck();
    await kit.runDue();
  }

  it("галочка без своих слов — человеку простой текст об отмене; агент видит его и записывает заново", async () => {
    const booking = await bookInDialog();
    const prompts: string[] = [];
    kit.reply = (call) => {
      prompts.push(JSON.stringify(call.options.prompt));
      return bookingReply(call);
    };

    expect(await cancelCallByExpert(cabinet(), booking.id, { tellPerson: true, staffName: "Дмитрий" })).toBe(true);
    await kit.runDue();
    const told = kit.textsTo(PERSON).at(-1)!;
    expect(told).toContain("10:00 (UTC+3)");
    expect(told).toMatch(/отмен/);
    expect(told).toMatch(/другое время/);

    await kit.send(PERSON, "Хочу на созвон");
    await kit.runDue();
    expect(prompts.some((prompt) => prompt.includes(JSON.stringify(told).slice(1, 40)))).toBe(true);
    expect((await activeBooking())?.startsAt.toISOString()).toBe("2026-11-20T07:00:00.000Z");
  });

  it("свои слова эксперта уходят как есть; галочка снята — человеку ничего", async () => {
    const booking = await bookInDialog();
    await cancelCallByExpert(cabinet(), booking.id, { tellPerson: true, text: "  Простите, заболел. Давайте выберем другой день?  " });
    await kit.runDue();
    expect(kit.textsTo(PERSON).at(-1)).toBe("Простите, заболел. Давайте выберем другой день?");

    await kit.send(PERSON, "Хочу на созвон");
    await kit.runDue();
    const again = await activeBooking();
    const before = kit.textsTo(PERSON).length;
    await cancelCallByExpert(cabinet(), again.id, { tellPerson: false, text: "Не уйдёт" });
    await kit.runDue();
    expect(kit.textsTo(PERSON)).toHaveLength(before);
  });

  it("очередь упала при отмене — сообщение доводит подмётчик, один раз", async () => {
    const booking = await bookInDialog();
    const enqueue = kit.queue.enqueue.bind(kit.queue);
    vi.spyOn(kit.queue, "enqueue").mockImplementation((async (name, payload, options) => {
      if (name === "outbound-send") throw new Error("Очередь недоступна");
      return enqueue(name, payload, options);
    }) as typeof kit.queue.enqueue);
    expect(await cancelCallByExpert(cabinet(), booking.id, { tellPerson: true, text: "Созвон отменён" })).toBe(true);
    vi.restoreAllMocks();
    await kit.runDue();
    expect(kit.textsTo(PERSON).filter((text) => text === "Созвон отменён")).toEqual([]);

    await sweepLater();
    expect(kit.textsTo(PERSON).filter((text) => text === "Созвон отменён")).toHaveLength(1);
    await sweepLater();
    expect(kit.textsTo(PERSON).filter((text) => text === "Созвон отменён")).toHaveLength(1);
  });

  it("сообщение об отмене не дошло — эксперт узнаёт в боте и в «Записях»", async () => {
    const booking = await bookInDialog();
    kit.channel.blockUser(PERSON);
    await cancelCallByExpert(cabinet(), booking.id, { tellPerson: true });
    await kit.runDue();

    await sweepLater();
    const alerts = textsToExpert().filter((text) => text.startsWith("Сообщение об отмене созвона не дошло"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/Человек person-1, пт, 20 ноября, 10:00–10:30/);
    await sweepLater();
    expect(textsToExpert().filter((text) => text.startsWith("Сообщение об отмене созвона не дошло"))).toHaveLength(1);

    const row = (await listCallBookings(kit.db, { now: kit.clock.now() })).find((item) => item.id === booking.id)!;
    expect(row.cancelMessageFailure).toMatch(/остановил бота/);
  });
});
