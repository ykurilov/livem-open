import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
// Ход консультанта по сценарию SDK (срез S3 переноса на «Сценарии»): ход через наш бот, дни и таймеры сценария,
// рамки дня, ночь, «срок вышел», конец разговора снаружи. Сообщения первым через бот — first-messages.integration.test.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { DEFAULT_CONSULTANT_REPLY, createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { HARD_DAY_FRAME_TEXT } from "../flows";
import { newProgramSettings, type LeadMagnetSettings, type Stage } from "../lead-magnets";
import { eq } from "drizzle-orm";
import { people } from "../people/schema";
import { updateSettings } from "../platform/settings";
import { AUTOREPLY_TEXT } from "./router";

// 14:00 по Москве 12 октября — день 1 программы; день 2 — с 9:00 13-го, день 3 — с 9:00 14-го, срок — 9:00 15-го
const START = new Date("2026-10-12T11:00:00Z");
const MSK = (iso: string) => new Date(`${iso}+03:00`);

const STAGES: Stage[] = [
  { id: "start", name: "Знакомство", instruction: "Узнай идею приложения.", transitionCondition: "Идея есть", startDay: null, isSale: false },
  { id: "build", name: "Сборка", instruction: "Помоги собрать приложение.", transitionCondition: "Прислал ссылку", startDay: 2, isSale: false },
  { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: 3, isSale: true },
];

const PROGRAM: Partial<LeadMagnetSettings> = { stages: STAGES, program: newProgramSettings(3), maxPersonMessages: 100 };

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
  await database.pool.query("update app.passages set status = 'not_completed' where status = 'active'");
  kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
  person = `user-${randomUUID().slice(0, 8)}`;
});

/** Срок «нода длится 1 день» из «Знакомства» в «Сборку»: перевод этапов его больше не ставит, а эксперт на доске может. */
const withDayTimer = (flow: AgentFlow): AgentFlow => ({
  ...flow,
  states: flow.states.map((state) =>
    state.id === "start" ? { ...state, exits: [...state.exits, { id: "start_build_days", when: { type: "timer", from: "state_days", days: 1 }, to: "build" }] } : state,
  ) as AgentFlow["states"],
});

async function start(settings: Partial<LeadMagnetSettings> = PROGRAM, adjustFlow?: (flow: AgentFlow) => AgentFlow) {
  const lead = await kit.publish(settings, adjustFlow);
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.runDue();
  return lead;
}

/** Сообщение человека и его ход; часы — только на склейку сообщений. */
async function say(text: string) {
  await kit.send(person, text);
  await kit.runDue();
  kit.clock.advance(5_000);
  await kit.runDue();
  await kit.dialog.flow.settled();
}

const passage = async () => (await kit.passagesOf(person))[0]!;
const promptOf = (call: (typeof kit.calls)[number]) => JSON.stringify(call.options.prompt);

describe("ход по сценарию через наш бот", () => {
  it("разговор закреплён за сценарием снимка с первого сообщения; ответ модели уходит в мессенджер, в запросе — карточка ноды", async () => {
    const lead = await start({});
    const run = await kit.dialog.flow.readRun((await kit.personOf(person))!.id, (await passage()).chatId);
    expect(run).toMatchObject({ state: "conversation" });

    await say("Привет, я дизайнер");
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
    const call = kit.consultantCalls().at(-1)!;
    expect(promptOf(call)).toContain("Провести разговор по общей инструкции");
    expect(call.system).toContain("# Разговор по сценарию");
    expect(call.toolNames).toEqual(expect.arrayContaining(["finish_dialog", "flow_exit", "flow_note", "client_card"]));
    expect(call.toolNames).not.toEqual(expect.arrayContaining(["go_to_stage"]));
    expect(lead.snapshotId).toBe((await passage()).snapshotId);
  });

  it("постоянная инструкция побайтно одна во все дни программы: день и нода — в хвосте и карточке", async () => {
    await start();
    await say("Хочу приложение для кофейни");
    const day1 = kit.consultantCalls().at(-1);
    kit.clock.set(MSK("2026-10-13T10:00:00"));
    await kit.dialog.flow.tick();
    await say("Доброе утро, продолжим");
    const day2 = kit.consultantCalls().at(-1);
    expect(day1!.lastUserText).toMatch(/День 1 из 3/);
    expect(day2!.lastUserText).toMatch(/День 2 из 3/);
    expect(day2!.system).toBe(day1!.system);
  });
});

describe("дни и таймеры сценария", () => {
  it("нода длится 1 день: в начале дня 2 этап сменился сам — история с причиной, кем решено и днём", async () => {
    await start(PROGRAM, withDayTimer);
    await say("Хочу приложение для кофейни");
    expect((await passage()).currentStageId).toBeNull();

    kit.clock.set(MSK("2026-10-13T10:00:00"));
    await kit.dialog.flow.tick();
    await say("Я тут, продолжим");

    const row = await passage();
    expect(row.currentStageId).toBe("build");
    expect(row.furthestDay).toBe(2);
    expect(row.stageHistory).toEqual([expect.objectContaining({ stageId: "build", by: "day", decidedBy: "timer", day: 2 })]);
    expect(promptOf(kit.consultantCalls().at(-1)!)).toContain("Помоги собрать приложение.");
  });

  /** Часы идут по часу до `until`, как обход таймеров работника. */
  async function walkHours(until: Date) {
    while (kit.clock.now() < until) {
      kit.clock.advance(60 * 60_000);
      await kit.dialog.flow.tick();
      await kit.dialog.flow.settled();
    }
  }

  const atNight = ({ at }: { at: Date }) => {
    const hour = (at.getUTCHours() + 3) % 24;
    return hour >= 21 || hour < 9;
  };

  it("срок вышел: касания по сценарию, ночью — ни одного; статус «срок вышел», новое сообщение — эксперту с автоответом", async () => {
    kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
    await start();
    await say("Хочу приложение для кофейни");
    await walkHours(MSK("2026-10-13T13:00:00"));
    await say("Собираю, вот что вышло");
    await walkHours(MSK("2026-10-15T10:00:00"));

    expect(await passage()).toMatchObject({ status: "term_ended" });
    const firstMessages = await kit.firstMessages();
    expect(firstMessages.length).toBeGreaterThan(0);
    expect(firstMessages.filter(atNight)).toEqual([]);

    const calls = kit.consultantCalls().length;
    await say("А можно ещё вопрос?");
    expect(kit.consultantCalls()).toHaveLength(calls);
    expect(kit.textsTo(person).at(-1)).toBe(AUTOREPLY_TEXT);
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox" });
  });

  it("быстрый человек вошёл в ноду перед «Продажей» в день 1 — «Продажа» не в день 2, а утром дня 3, одним сообщением", async () => {
    kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
    kit.reply = (call) =>
      call.lastToolResult === undefined && call.lastUserText.includes("Идея есть")
        ? { toolCalls: [{ toolName: "flow_exit", input: { exit: 1, why: "Идея есть" } }] }
        : { text: DEFAULT_CONSULTANT_REPLY };
    kit.judge = (call) => (JSON.stringify(call.options.prompt).includes("приложение для кофейни") ? ["start_done"] : []);
    await start();
    await say("Идея есть: приложение для кофейни");
    expect((await passage()).currentStageId).toBe("build");

    await walkHours(MSK("2026-10-13T12:00:00"));
    await say("Собираю, вот что вышло");
    expect((await passage()).currentStageId).toBe("build");

    await walkHours(MSK("2026-10-14T10:00:00"));
    const row = await passage();
    expect(row.currentStageId).toBe("sale");
    expect(row.stageHistory.at(-1)).toMatchObject({ stageId: "sale", day: 3, decidedBy: "timer" });
    // Утреннее сообщение дня 3 — уже из «Продажи», и оно одно
    const day3 = (await kit.firstMessages()).filter(({ at }) => at >= MSK("2026-10-14T09:00:00"));
    expect(day3).toHaveLength(1);
    expect(promptOf(kit.consultantCalls().at(-1)!)).toContain("Предложи курс.");
  });

  // Касаний больше пяти подряд (потолок ядра для ходов сервера): сценарий SDK 0.53 ведёт их по своему расписанию
  it("молчун все три дня: «срок вышел» наступает", async () => {
    kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
    await start();
    await say("Хочу приложение для кофейни");
    await walkHours(MSK("2026-10-15T10:00:00"));
    expect(await passage()).toMatchObject({ status: "term_ended" });
  });

  /** Сообщений первым по дням по Москве: «2026-10-12» → число. */
  async function firstMessagesByDay() {
    const days: Record<string, number> = {};
    for (const { at } of await kit.firstMessages()) {
      const day = new Date(at.getTime() + 3 * 60 * 60_000).toISOString().slice(0, 10);
      days[day] = (days[day] ?? 0) + 1;
    }
    return days;
  }

  // Судья eval 19.10: молчуну до 14 сообщений за 4 дня. Решение Дмитрия: первый день — как было, со второго — не больше двух
  it("молчун в программе: в день входа — частые касания (3), со второго дня — не больше двух в день", async () => {
    kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
    await start();
    await say("Хочу приложение для кофейни");
    await walkHours(MSK("2026-10-15T08:00:00"));
    const days = await firstMessagesByDay();
    expect(days["2026-10-12"]).toBe(3);
    expect(days["2026-10-13"]).toBeLessThanOrEqual(2);
    expect(days["2026-10-14"]).toBeLessThanOrEqual(2);
  });

  it("ответ человека потолок дня не обнуляет: со второго дня всё равно не больше двух сообщений первым", async () => {
    kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
    await start();
    await say("Хочу приложение для кофейни");
    await walkHours(MSK("2026-10-13T13:00:00"));
    await say("Пока не успел");
    await walkHours(MSK("2026-10-14T08:00:00"));
    expect((await firstMessagesByDay())["2026-10-13"]).toBeLessThanOrEqual(2);
  });

  it("в ноду первого дня вошёл во второй день — частых касаний нет: после утреннего следующее через 3 ч", async () => {
    kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
    // «Сборка» без дня начала — нода первого дня; в неё по сроку утром дня 2
    await start({ ...PROGRAM, stages: [STAGES[0]!, { ...STAGES[1]!, startDay: null }, STAGES[2]!] }, withDayTimer);
    await say("Хочу приложение для кофейни");
    await walkHours(MSK("2026-10-13T20:00:00"));
    expect((await passage()).currentStageId).toBe("build");
    const mskClock = (at: Date) => new Date(at.getTime() + 3 * 60 * 60_000).toISOString().slice(11, 16);
    const day2 = (await kit.firstMessages()).filter(({ at }) => at >= MSK("2026-10-13T09:00:00")).map(({ at }) => mskClock(at));
    expect(day2).toEqual(["09:00", "12:00"]);
  });

  it("молчун без программы: в день входа — 15 мин, 1 ч и вечер, дальше — не больше двух в день", async () => {
    kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
    await start({});
    await say("Привет, я дизайнер");
    await walkHours(MSK("2026-10-15T08:00:00"));
    const days = await firstMessagesByDay();
    expect(days["2026-10-12"]).toBe(3);
    expect(days["2026-10-13"]).toBeLessThanOrEqual(2);
    expect(days["2026-10-14"]).toBeLessThanOrEqual(2);
  });
});

describe("рамки дня и ночь", () => {
  const FRAMED: Partial<LeadMagnetSettings> = { ...PROGRAM, program: { ...newProgramSettings(3), softDailyMessages: 2, hardDailyMessages: 3 } };

  it("после жёсткой рамки «Утром отвечу!» уходит один раз без модели, дальше тишина; мягкая рамка — строкой хвоста", async () => {
    await start(FRAMED);
    await say("Первое");
    await say("Второе");
    expect(kit.consultantCalls().at(-1)!.lastUserText).toMatch(/свора|завтра/i);
    const calls = kit.consultantCalls().length;

    await say("Третье");
    await say("Четвёртое");

    expect(kit.consultantCalls()).toHaveLength(calls);
    expect(kit.textsTo(person).filter((text) => text === HARD_DAY_FRAME_TEXT)).toHaveLength(1);
    expect(kit.textsTo(person).at(-1)).toBe(HARD_DAY_FRAME_TEXT);
    // Сообщения записаны: утром на них ответит сценарий одним ходом
    expect((await kit.inboundOf(person)).slice(-2).every((row) => row.answeredAt !== null && row.route === "passage")).toBe(true);
  });

  it("человек написал в 23:00 — консультант отвечает: ночь только для сообщений первым", async () => {
    await start();
    kit.clock.set(MSK("2026-10-12T23:00:00"));
    await say("Не сплю, придумал идею");
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
  });
});

describe("продажа и деньги", () => {
  it("sale_answer только в ноде «Продажа»: раньше сценарий не пускает, в «Продаже» причина записана в прохождение, второе мягкое «нет» — разобрано", async () => {
    const results: unknown[] = [];
    kit.reply = (call) => {
      if (call.lastToolResult !== undefined) {
        results.push(call.lastToolResult);
        return { text: "Понял, вернёмся к приложению." };
      }
      if (call.lastUserText.includes("готов")) return { toolCalls: [{ toolName: "flow_exit", input: { exit: 1, why: "Идея есть" } }] };
      if (call.lastUserText.includes("дорого")) return { toolCalls: [{ toolName: "sale_answer", input: { reason: "price", firm: false } }] };
      return { text: DEFAULT_CONSULTANT_REPLY };
    };
    // Судья подтверждает переход, только когда человек сказал, что готов
    kit.judge = (call) => (JSON.stringify(call.options.prompt).includes("я готов") ? ["start_done"] : []);
    await start({ stages: [STAGES[0]!, { ...STAGES[2]!, startDay: null }] });
    await say("Пока дорого для меня");
    expect((await passage()).saleAnswer).toBeNull();
    expect(JSON.stringify(results[0])).toMatch(/недоступн/i);

    await say("Идея есть, я готов");
    expect((await passage()).currentStageId).toBe("sale");
    await say("Пока дорого для меня");
    expect((await passage()).saleAnswer).toMatchObject({ reason: "price", firm: false, softHandled: false });
    await say("Всё-таки дорого");
    expect((await passage()).saleAnswer).toMatchObject({ reason: "price", softHandled: true, lastOfferDay: 1 });
    // Живой ответ после разобранного «нет» — строка продажи в хвосте
    await say("Расскажи ещё про приложение");
    expect(kit.consultantCalls().at(-1)!.lastUserText).toMatch(/Мягкий отказ уже разобран/);
  });

  it("дневной лимит в $: модель не зовётся, ход ждёт начала дня программы по поясу человека", async () => {
    await updateSettings(database.db, { dailyLimitUsd: "1" });
    try {
      await start();
      const personRow = (await kit.personOf(person))!;
      await database.db.update(people).set({ timeZone: "Asia/Novosibirsk" }).where(eq(people.id, personRow.id));
      await kit.spend(personRow.id, 1);

      await say("Ещё вопрос");
      expect(kit.consultantCalls()).toHaveLength(0);
      // Расход обнуляется в полночь по Москве (04:00 в Новосибирске), начало дня — 9:00 в Новосибирске = 02:00 UTC
      expect(kit.queue.pending.filter((job) => job.name === "inbound-turn").map((job) => job.runAt)).toEqual([
        new Date("2026-10-13T02:00:00Z").getTime(),
      ]);
    } finally {
      await updateSettings(database.db, { dailyLimitUsd: "1000" });
    }
  });
});

describe("конец разговора снаружи", () => {
  it("ссылка другого лидмагнита посреди разговора: старый — «не завершил», в сценарии конец «switched»", async () => {
    await start({});
    await say("Привет");
    const old = await passage();
    const other = await kit.publish({ name: `Другой ${randomUUID().slice(0, 4)}` });
    await kit.send(person, `/start ${other.code}`, { startCode: other.code });
    await kit.runDue();
    await kit.dialog.flow.settled();

    const [first, second] = await kit.passagesOf(person);
    expect(first).toMatchObject({ id: old.id, status: "not_completed" });
    expect(second).toMatchObject({ status: "active" });
    expect(await kit.dialog.flow.readRun(old.personId, old.chatId)).toMatchObject({ endReason: "switched" });
  });

  it("конец в сценарии — после записи решения: в момент end прохождение в базе уже закрыто (ссылка другого лидмагнита и блокировка)", async () => {
    // Что видит любое другое соединение в момент конца сценария: внутри открытой транзакции прохождение ещё «активно»
    const seen: Array<{ reason: string; status: string | undefined }> = [];
    const end = kit.dialog.flow.end.bind(kit.dialog.flow);
    kit.dialog.flow.end = async (input) => {
      const { rows } = await database.pool.query<{ status: string }>("select status from app.passages where chat_id = $1", [input.chatId]);
      seen.push({ reason: input.reason, status: rows[0]?.status });
      return end(input);
    };

    await start({});
    await say("Привет");
    const other = await kit.publish({ name: `Другой ${randomUUID().slice(0, 4)}` });
    await kit.send(person, `/start ${other.code}`, { startCode: other.code });
    await kit.runDue();
    await kit.webhook([{ type: "blocked", dedupeKey: `${person}-blocked`, userId: person }]);
    await kit.runDue();
    await kit.dialog.flow.settled();

    expect(seen).toEqual([
      { reason: "switched", status: "not_completed" },
      { reason: "blocked", status: "blocked" },
    ]);
  });

  it("человек заблокировал бота: прохождение «заблокировал», в сценарии конец «blocked»", async () => {
    await start({});
    await say("Привет");
    const row = await passage();
    await kit.webhook([{ type: "blocked", dedupeKey: `${person}-blocked`, userId: person }]);
    await kit.runDue();
    await kit.dialog.flow.settled();

    expect(await passage()).toMatchObject({ status: "blocked" });
    expect(await kit.dialog.flow.readRun(row.personId, row.chatId)).toMatchObject({ endReason: "blocked" });
  });
});
