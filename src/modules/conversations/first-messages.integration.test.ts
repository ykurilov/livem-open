// Агент пишет первым (срез S6): касания сценария уходят через наш бот, ночь и потолок дня, одно утреннее сообщение,
// «не завершил» после тишины, блокировка и закрытое окно ВК при доставке. Часы подменены, обход таймеров — вручную.
import { randomUUID } from "node:crypto";
import type { AgentFlow } from "@ykurilov/agent-chat-flows";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { KIT_CIPHER, createLiveDialogKit, outboundOf, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { newProgramSettings, type LeadMagnetSettings, type Stage } from "../lead-magnets";
import { checkAllBots } from "../channels";
import { PERSON_WROTE_AFTER_TOUCH_ERROR, REPAIR_WINDOW_PASSED_ERROR } from "../flows/delivery";
import { REPAIR_WAIT_GONE_ERROR, resumeOutreachAwaitingRepair } from "../flows/delivery-repair";
import { markPersonBlocked } from "../people";
import { updateSettings } from "../platform/settings";

// 14:00 по Москве 12 октября; у программы день 2 — с 9:00 13-го
const START = new Date("2026-10-12T11:00:00Z");
const MSK = (iso: string) => new Date(`${iso}+03:00`);
const MINUTE = 60_000;

const STAGES: Stage[] = [
  { id: "start", name: "Знакомство", instruction: "Узнай идею приложения.", transitionCondition: "Идея есть", startDay: null, isSale: false },
  { id: "build", name: "Сборка", instruction: "Помоги собрать приложение.", transitionCondition: "Прислал ссылку", startDay: 2, isSale: false },
  { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: 3, isSale: true },
];

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { dailyLimitUsd: "1000", monthlyBudgetUsd: null });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  // Чаты прошлых тестов не будят таймеры этого: у каждого теста свои часы
  await database.pool.query("do $$ begin if to_regclass('agent_chat.flow_chats') is not null then delete from agent_chat.flow_chats; end if; end $$");
  kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
  person = `user-${randomUUID().slice(0, 8)}`;
});

async function start(settings: Partial<LeadMagnetSettings> = {}, adjustFlow?: (flow: AgentFlow) => AgentFlow) {
  const lead = await kit.publish(settings, adjustFlow);
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.runDue();
  return lead;
}

async function say(text: string) {
  await kit.send(person, text);
  await kit.runDue();
  kit.clock.advance(5_000);
  await kit.runDue();
  await kit.dialog.flow.settled();
}

/** Часы идут шагами до `until`, как обход таймеров работника. */
async function walk(until: Date, stepMs = 5 * MINUTE) {
  while (kit.clock.now() < until) {
    kit.clock.advance(Math.min(stepMs, until.getTime() - kit.clock.now().getTime()));
    await kit.dialog.flow.tick();
    await kit.dialog.flow.settled();
    await kit.runDue();
  }
}

const passage = async () => (await kit.passagesOf(person))[0]!;
const outreach = async () => (await outboundOf(kit)).filter((row) => row.kind === "outreach").sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0));
const attemptsTo = () => kit.channel.attempts.filter((attempt) => attempt.to === person).length;
const delivered = async () => (await outreach()).filter((row) => row.status === "sent");

describe("касания через наш бот", () => {
  it("молчание 15 минут и час — по касанию в мессенджер человека, в исходящих «первым», расход — строкой first_message", async () => {
    await start();
    await say("Привет, я дизайнер");
    const afterReply = kit.textsTo(person).length;

    await walk(new Date(kit.clock.now().getTime() + 16 * MINUTE));
    expect(await delivered()).toHaveLength(1);
    await walk(new Date(kit.clock.now().getTime() + 60 * MINUTE));
    expect(await delivered()).toHaveLength(2);

    expect(kit.textsTo(person)).toHaveLength(afterReply + 2);
    const row = await passage();
    expect((await delivered()).every((message) => message.passageId === row.id)).toBe(true);
    const usage = await kit.chatStorage.sumUsage({ chatId: row.chatId, source: "first_message" });
    expect(usage.length).toBeGreaterThan(0);
  });

  it("3 дня тишины — разговор «не завершил», без сообщения", async () => {
    // Без касаний по часам дня: два касания, дальше тишина до «не завершил»
    await start({}, (flow) => ({ ...flow, nudges: { afterSilence: [{ amount: 15, unit: "min" }, { amount: 1, unit: "h" }], giveUpAfter: { amount: 3, unit: "d" } } }));
    await say("Привет");

    await walk(MSK("2026-10-15T15:00:00"), 60 * MINUTE);
    expect(await passage()).toMatchObject({ status: "not_completed" });
    expect(await delivered()).toHaveLength(2);
  });

  it("человек заблокировал бота — касание не засчитано, разговор «заблокировал», человек помечен, дальше тишина", async () => {
    await start();
    await say("Привет");
    kit.channel.blockUser(person);

    await walk(new Date(kit.clock.now().getTime() + 20 * MINUTE));
    expect(await passage()).toMatchObject({ status: "blocked" });
    expect((await kit.personOf(person))!.blockedAt).not.toBeNull();
    const attempts = attemptsTo();
    await walk(new Date(kit.clock.now().getTime() + 6 * 60 * MINUTE), 30 * MINUTE);
    expect(attemptsTo()).toBe(attempts);
    expect(await delivered()).toEqual([]);
  });

  it("ВК не даёт писать первым (950) — молчим до ответа человека, потом касания снова идут", async () => {
    await start();
    await say("Привет");
    kit.channel.failNext({ ok: false, reason: "reply_window_closed" });

    await walk(new Date(kit.clock.now().getTime() + 20 * MINUTE));
    const attempts = attemptsTo();
    await walk(new Date(kit.clock.now().getTime() + 4 * 60 * MINUTE), 15 * MINUTE);
    expect(attemptsTo()).toBe(attempts);
    expect(await delivered()).toEqual([]);
    expect(await passage()).toMatchObject({ status: "active" });

    await say("Я вернулся");
    await walk(new Date(kit.clock.now().getTime() + 20 * MINUTE));
    expect(await delivered()).toHaveLength(1);
  });
});

describe("когда писать первым нельзя", () => {
  const TWO_NUDGES = (flow: AgentFlow): AgentFlow => ({
    ...flow,
    nudges: { afterSilence: [{ amount: 15, unit: "min" }, { amount: 1, unit: "h" }], giveUpAfter: { amount: 3, unit: "d" } },
  });

  it("аварийная остановка бюджета — «не сейчас»: касание ждёт, после снятия остановки уходит, «не завершил» в свой срок", async () => {
    await start({}, TWO_NUDGES);
    await say("Привет");
    try {
      await updateSettings(database.db, { monthlyBudgetUsd: "10" });
      await kit.spend("someone", 20);

      await walk(new Date(kit.clock.now().getTime() + 3 * 60 * MINUTE), 15 * MINUTE);
      expect(await delivered()).toEqual([]);
    } finally {
      await updateSettings(database.db, { monthlyBudgetUsd: null });
    }

    await walk(new Date(kit.clock.now().getTime() + 2 * 60 * MINUTE), 15 * MINUTE);
    expect((await delivered()).length).toBeGreaterThan(0);
    await walk(MSK("2026-10-15T16:00:00"), 60 * MINUTE);
    expect(await passage()).toMatchObject({ status: "not_completed" });
  });

  it("человек заблокировал бота (узнали из другой отправки) — касаний нет, «не завершил» в свой срок", async () => {
    await start({}, TWO_NUDGES);
    await say("Привет");
    await markPersonBlocked(database.db, (await kit.personOf(person))!.id, kit.clock.now());
    const attempts = attemptsTo();

    await walk(new Date(kit.clock.now().getTime() + 3 * 60 * MINUTE), 15 * MINUTE);
    expect(attemptsTo()).toBe(attempts);
    await walk(MSK("2026-10-15T16:00:00"), 60 * MINUTE);
    expect(await delivered()).toEqual([]);
    expect(await passage()).toMatchObject({ status: "not_completed" });
  });
});

describe("бот сломан (токен отозван) — касание ждёт починки, после неё уходит то же", () => {
  const TWO_NUDGES = (flow: AgentFlow): AgentFlow => ({
    ...flow,
    nudges: { afterSilence: [{ amount: 15, unit: "min" }, { amount: 1, unit: "h" }], giveUpAfter: { amount: 3, unit: "d" } },
  });
  const FAREWELL = "Наша трёхдневка закончилась!";
  const PROGRAM_WITH_FAREWELL: Partial<LeadMagnetSettings> = { stages: STAGES, program: newProgramSettings(3), maxPersonMessages: 100 };
  const withFarewell = (flow: AgentFlow): AgentFlow => ({ ...flow, schedule: { ...flow.schedule!, farewellOnDeadline: true, farewellText: FAREWELL } });

  const botHealth = () => ({ db: database.db, queue: kit.queue, alerts: kit.alerts, adapters: { telegram: kit.channel }, cipher: KIT_CIPHER });
  /** Обход починки, как в задаче проверки ботов работника. */
  const scanRepairs = () => resumeOutreachAwaitingRepair({ db: database.db, flow: kit.dialog.flow });
  const triesOf = (key: string) => kit.channel.attempts.filter((attempt) => attempt.idempotencyKey === key).length;
  const rowOf = async (id: string) => (await outreach()).find((row) => row.id === id);
  const minutesLater = (minutes: number) => new Date(kit.clock.now().getTime() + minutes * MINUTE);

  /** Следующая отправка упадёт отозванным токеном, проверка бота это подтвердит. */
  function breakBot() {
    kit.channel.breakConnection("Unauthorized");
    kit.channel.failNext({ ok: false, reason: "permanent", error: "Unauthorized" });
  }

  /** Бот исправен: проверка ботов работника ставит ему «работает» и повторяет помеченные исходящие очереди. */
  async function repairBot() {
    kit.channel.breakConnection(null);
    await checkAllBots(botHealth());
    await kit.drain();
  }

  /** Первое касание уходит в сломанный бот: сценарий ждёт починки, попытка не тратится, других касаний нет. */
  async function touchIntoBrokenBot() {
    await start({}, TWO_NUDGES);
    await say("Привет");
    breakBot();
    await walk(minutesLater(16));
    const [first] = await outreach();
    expect(first).toMatchObject({ status: "awaiting_repair", awaitsBotRepair: false });
    await walk(minutesLater(6 * 60), 30 * MINUTE);
    expect(triesOf(first!.idempotencyKey!)).toBe(1);
    expect(await outreach()).toHaveLength(1);
    return { id: first!.id, key: first!.idempotencyKey! };
  }

  /** Программа на 3 дня с прощанием «срок вышел»; бот ломается перед самым сроком — прощание ждёт починки. */
  async function farewellIntoBrokenBot() {
    await start(PROGRAM_WITH_FAREWELL, withFarewell);
    await say("Хочу приложение для кофейни");
    await walk(MSK("2026-10-15T08:00:00"), 60 * MINUTE);
    breakBot();
    await walk(MSK("2026-10-15T10:00:00"), 15 * MINUTE);
    const row = await passage();
    expect(row).toMatchObject({ status: "term_ended" });
    const farewell = (await outreach()).find((message) => message.text === FAREWELL);
    expect(farewell).toMatchObject({ status: "awaiting_repair" });
    const run = await kit.dialog.flow.readRun(row.personId, row.chatId);
    expect(run).toMatchObject({ endReason: "deadline" });
    return { id: farewell!.id, key: farewell!.idempotencyKey!, row, run };
  }

  it("починили — уходит то же касание (тот же messageId) один раз: очередь его не берёт, второй обход не шлёт", async () => {
    const first = await touchIntoBrokenBot();
    // Пока бот сломан, обходу возобновлять нечего
    expect(await scanRepairs()).toMatchObject({ resumed: 0 });

    await repairBot();
    expect(triesOf(first.key)).toBe(1);
    expect(await scanRepairs()).toMatchObject({ resumed: 1 });
    await walk(minutesLater(5));
    expect((await delivered()).map((row) => row.idempotencyKey)).toEqual([first.key]);
    expect(triesOf(first.key)).toBe(2);

    expect(await scanRepairs()).toEqual({ resumed: 0, pending: 0, busy: 0, not_found: 0, dropped: 0, error: 0 });
    await walk(minutesLater(5));
    expect(triesOf(first.key)).toBe(2);
  });

  it("сигнал починки потерян, работник перезапущен — следующий обход доставляет то же касание", async () => {
    const first = await touchIntoBrokenBot();
    await repairBot();
    // Обход починки не случился: сценарий ждёт дальше сам по себе
    await walk(minutesLater(2 * 60), 30 * MINUTE);
    expect(triesOf(first.key)).toBe(1);

    await kit.restartWorker();
    expect(await scanRepairs()).toMatchObject({ resumed: 1 });
    await walk(minutesLater(5));
    expect((await delivered()).map((row) => row.idempotencyKey)).toEqual([first.key]);
    expect(triesOf(first.key)).toBe(2);
  });

  it("сценарий занят (busy) или упал на возобновлении — запись ждёт, следующий обход доставляет", async () => {
    const first = await touchIntoBrokenBot();
    await repairBot();
    const busy = await resumeOutreachAwaitingRepair({ db: database.db, flow: { resumeDelivery: async () => "busy" } });
    expect(busy).toMatchObject({ busy: 1 });
    const errors: string[] = [];
    const failing = await resumeOutreachAwaitingRepair({
      db: database.db,
      flow: { resumeDelivery: async () => Promise.reject(new Error("база недоступна")) },
      logError: (message) => errors.push(message),
    });
    expect(failing).toMatchObject({ error: 1 });
    expect(errors).toEqual([expect.stringContaining("база недоступна")]);
    expect(await rowOf(first.id)).toMatchObject({ status: "awaiting_repair" });
    await walk(minutesLater(30));
    expect(triesOf(first.key)).toBe(1);

    expect(await scanRepairs()).toMatchObject({ resumed: 1 });
    await walk(minutesLater(5));
    expect((await delivered()).map((row) => row.idempotencyKey)).toEqual([first.key]);
  });

  it("человек написал, пока бот сломан — старое касание не уходит, запись закрыта", async () => {
    const first = await touchIntoBrokenBot();
    await say("Я тут, просто был занят");
    await repairBot();

    expect(await scanRepairs()).toMatchObject({ dropped: 1 });
    await walk(minutesLater(10));
    expect(triesOf(first.key)).toBe(1);
    expect(await rowOf(first.id)).toMatchObject({ status: "failed", error: REPAIR_WAIT_GONE_ERROR });
  });

  it("сценарий закончили явно (flow.end) — старое касание не уходит, запись закрыта", async () => {
    const first = await touchIntoBrokenBot();
    const row = await passage();
    expect(await kit.dialog.flow.end({ ownerId: row.personId, chatId: row.chatId, reason: "switched" })).toEqual({ ended: true });
    await repairBot();

    expect(await scanRepairs()).toMatchObject({ not_found: 1 });
    await walk(minutesLater(30));
    expect(triesOf(first.key)).toBe(1);
    expect(await rowOf(first.id)).toMatchObject({ status: "failed", error: REPAIR_WAIT_GONE_ERROR });
  });

  it("окно починки 3 суток вышло (время базы) — касание не уходит и не засчитано, сценарий идёт дальше", async () => {
    const first = await touchIntoBrokenBot();
    await database.pool.query("update app.outbound_messages set created_at = now() - interval '3 days 1 minute' where id = $1", [first.id]);
    // Бот ещё сломан, но ждать больше нечего: обход отдаёт касание сценарию, доставка закрывает его без отправки
    expect(await scanRepairs()).toMatchObject({ resumed: 1 });
    await walk(minutesLater(5));
    expect(triesOf(first.key)).toBe(1);
    expect(await rowOf(first.id)).toMatchObject({ status: "failed", error: REPAIR_WINDOW_PASSED_ERROR });

    await repairBot();
    await walk(minutesLater(2 * 60), 15 * MINUTE);
    const sent = await delivered();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((row) => row.idempotencyKey)).not.toContain(first.key);
  });

  it("прощание «срок вышел» ждёт починки — после неё уходит один раз, разговор заново не открывается", async () => {
    const farewell = await farewellIntoBrokenBot();
    await repairBot();
    expect(await scanRepairs()).toMatchObject({ resumed: 1 });
    await walk(minutesLater(30), 5 * MINUTE);

    expect(kit.textsTo(person).filter((text) => text === FAREWELL)).toHaveLength(1);
    expect(await rowOf(farewell.id)).toMatchObject({ status: "sent" });
    expect(await passage()).toMatchObject({ status: "term_ended" });
    const run = await kit.dialog.flow.readRun(farewell.row.personId, farewell.row.chatId);
    expect(run?.endReason).toBe(farewell.run?.endReason);
    expect(run?.endedAt).toEqual(farewell.run?.endedAt);

    const attempts = attemptsTo();
    await walk(minutesLater(24 * 60), 60 * MINUTE);
    expect(attemptsTo()).toBe(attempts);
  });

  it("человек написал после «срок вышел» (во «Входящие»), потом бота починили — старое прощание не уходит", async () => {
    const farewell = await farewellIntoBrokenBot();
    await kit.send(person, "А можно ещё вопрос?");
    await kit.runDue();
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox" });
    await repairBot();

    // Сценарий этого сообщения не видит и возобновляет прощание: устаревшее закрывает доставка приложения
    expect(await scanRepairs()).toMatchObject({ resumed: 1 });
    await walk(minutesLater(30), 5 * MINUTE);
    expect(kit.textsTo(person)).not.toContain(FAREWELL);
    expect(triesOf(farewell.key)).toBe(1);
    expect(await rowOf(farewell.id)).toMatchObject({ status: "failed", error: PERSON_WROTE_AFTER_TOUCH_ERROR });
    expect(await passage()).toMatchObject({ status: "term_ended" });
  });

  /** Прощание ждало починки; после неё первая возобновлённая отправка упала временным сбоем — сценарий повторит её. */
  async function farewellResumedThenTemporaryFailure() {
    const farewell = await farewellIntoBrokenBot();
    await repairBot();
    expect(await scanRepairs()).toMatchObject({ resumed: 1 });
    kit.channel.failNext({ ok: false, reason: "temporary", error: "сеть" });
    await walk(minutesLater(1), MINUTE);
    expect(triesOf(farewell.key)).toBe(2);
    expect(await rowOf(farewell.id)).toMatchObject({ status: "failed" });
    return farewell;
  }

  it("после починки временный сбой, затем человек написал во «Входящие» — повтор сценария старое прощание не шлёт", async () => {
    const farewell = await farewellResumedThenTemporaryFailure();
    await kit.send(person, "А можно ещё вопрос?");
    await kit.runDue();
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox" });

    await walk(minutesLater(60), 5 * MINUTE);
    expect(kit.textsTo(person)).not.toContain(FAREWELL);
    expect(triesOf(farewell.key)).toBe(2);
    expect(await rowOf(farewell.id)).toMatchObject({ status: "failed", error: PERSON_WROTE_AFTER_TOUCH_ERROR });
    expect(await passage()).toMatchObject({ status: "term_ended" });
  });

  it("после починки временный сбой, человек молчит — повтор сценария доставляет то же прощание один раз", async () => {
    const farewell = await farewellResumedThenTemporaryFailure();

    await walk(minutesLater(60), 5 * MINUTE);
    expect(kit.textsTo(person).filter((text) => text === FAREWELL)).toHaveLength(1);
    expect(triesOf(farewell.key)).toBe(3);
    expect(await rowOf(farewell.id)).toMatchObject({ status: "sent" });
    expect(await passage()).toMatchObject({ status: "term_ended" });
  });

  it("прощание ждёт починки, а прохождение закрыли явно — не уходит, разговор заново не открывается", async () => {
    const farewell = await farewellIntoBrokenBot();
    await database.pool.query("update app.passages set status = 'completed' where id = $1", [farewell.row.id]);
    await repairBot();

    expect(await scanRepairs()).toMatchObject({ resumed: 1 });
    await walk(minutesLater(30), 5 * MINUTE);
    expect(kit.textsTo(person)).not.toContain(FAREWELL);
    expect(triesOf(farewell.key)).toBe(1);
    // Сценарий уже закончен сроком: доставка ответила «не доставлено», ждать больше нечего — следующий обход закрывает запись
    expect(await scanRepairs()).toMatchObject({ not_found: 1 });
    expect(await rowOf(farewell.id)).toMatchObject({ status: "failed", error: REPAIR_WAIT_GONE_ERROR });
    expect(await passage()).toMatchObject({ status: "completed" });
    expect((await kit.dialog.flow.readRun(farewell.row.personId, farewell.row.chatId))?.endReason).toBe(farewell.run?.endReason);
  });
});

describe("закрытое прохождение — касаний нет", () => {
  const TWO_NUDGES = (flow: AgentFlow): AgentFlow => ({
    ...flow,
    nudges: { afterSilence: [{ amount: 15, unit: "min" }, { amount: 1, unit: "h" }], giveUpAfter: { amount: 3, unit: "d" } },
  });

  it("предел сообщений лидмагнита без программы: «завершил», в сценарии конец «message_limit», касаний дальше нет", async () => {
    await start({ maxPersonMessages: 2 }, TWO_NUDGES);
    await say("Привет");
    await say("Я дизайнер");
    const row = await passage();
    expect(row).toMatchObject({ status: "completed" });
    expect(await kit.dialog.flow.readRun(row.personId, row.chatId)).toMatchObject({ endReason: "message_limit" });

    const attempts = attemptsTo();
    await walk(new Date(kit.clock.now().getTime() + 3 * 60 * MINUTE), 15 * MINUTE);
    expect(attemptsTo()).toBe(attempts);
    expect(await delivered()).toEqual([]);
  });

  it("прохождение закрыто, а сценарий жив (сбой между записью и концом) — касание не уходит, сценарий заканчивается", async () => {
    await start({}, TWO_NUDGES);
    await say("Привет");
    const row = await passage();
    await database.pool.query("update app.passages set status = 'completed', ended_at = now() where id = $1", [row.id]);
    const attempts = attemptsTo();

    await walk(new Date(kit.clock.now().getTime() + 20 * MINUTE));
    expect(attemptsTo()).toBe(attempts);
    expect(await outreach()).toEqual([]);
    expect(await kit.dialog.flow.readRun(row.personId, row.chatId)).toMatchObject({ endReason: "passage_closed" });
    expect(await passage()).toMatchObject({ status: "completed" });
  });
});

/** Срок «нода длится 1 день» из «Знакомства» в «Сборку»: перевод этапов его больше не ставит, а эксперт на доске может. */
const withDayTimer = (flow: AgentFlow): AgentFlow => ({
  ...flow,
  states: flow.states.map((state) =>
    state.id === "start" ? { ...state, exits: [...state.exits, { id: "start_build_days", when: { type: "timer", from: "state_days", days: 1 }, to: "build" }] } : state,
  ) as AgentFlow["states"],
});

describe("программа по дням", () => {
  const FRAMED: Partial<LeadMagnetSettings> = {
    stages: STAGES,
    program: { ...newProgramSettings(3), softDailyMessages: 2, hardDailyMessages: 3 },
    maxPersonMessages: 100,
  };

  it("ночью первым не пишет; утро дня 2 — одно сообщение на переход по сроку, утреннее и ночные сообщения", async () => {
    await start(FRAMED, withDayTimer);
    await say("Первое");
    await say("Второе");
    await say("Третье"); // жёсткая рамка: «Утром отвечу!»
    kit.clock.set(MSK("2026-10-12T23:30:00"));
    await say("Ночью придумал ещё одно");

    await walk(MSK("2026-10-13T08:59:00"), 30 * MINUTE);
    const night = (await delivered()).filter((row) => {
      const hour = (row.sentAt!.getUTCHours() + 3) % 24;
      return hour >= 21 || hour < 9;
    });
    expect(night).toEqual([]);
    const before = (await delivered()).length;

    await walk(MSK("2026-10-13T09:30:00"));
    expect((await delivered()).length - before).toBe(1);
    expect(await passage()).toMatchObject({ currentStageId: "build" });
  });

  it("не больше 3 сообщений первым за день: пятое касание ряда ждёт следующего дня", async () => {
    const everyQuarter = { afterSilence: Array.from({ length: 5 }, () => ({ amount: 15, unit: "min" as const })) };
    await start({ stages: STAGES, program: newProgramSettings(3), maxPersonMessages: 100 }, (flow) => ({
      ...flow,
      states: flow.states.map((state) => (state.id === "start" ? { ...state, nudges: everyQuarter } : state)) as AgentFlow["states"],
    }));
    await say("Привет");
    await walk(MSK("2026-10-12T20:59:00"));
    expect(await delivered()).toHaveLength(3);
  });


  /** Касания ноды — общие «Дней и времени» (3 ч тишины): ночью нечего откладывать на утро. */
  const scheduleNudgesOnly = (flow: AgentFlow): AgentFlow => ({ ...flow, states: flow.states.map(({ nudges: _own, ...state }) => state) as AgentFlow["states"] });

  it("человек писал меньше 3 часов назад — утреннее не уходит", async () => {
    await start({ stages: [{ ...STAGES[0]!, startDay: null }], program: newProgramSettings(3), maxPersonMessages: 100 }, scheduleNudgesOnly);
    await say("Привет");
    kit.clock.set(MSK("2026-10-13T07:00:00"));
    await say("Рано встал, вот идея");
    const before = (await delivered()).length;

    await walk(MSK("2026-10-13T09:30:00"));
    expect((await delivered()).length).toBe(before);
  });

  // Касание тишины, отложенное ночью до начала дня (15 минут после ответа в 7:00 → 9:00), ждёт тех же 3 часов
  it("касание, отложенное ночью до утра, тоже не уходит, если человек писал меньше 3 часов назад", async () => {
    await start({ stages: [{ ...STAGES[0]!, startDay: null }], program: newProgramSettings(3), maxPersonMessages: 100 });
    await say("Привет");
    kit.clock.set(MSK("2026-10-13T07:00:00"));
    await say("Рано встал, вот идея");
    const before = (await delivered()).length;

    await walk(MSK("2026-10-13T09:30:00"));
    expect((await delivered()).length).toBe(before);
  });

});
