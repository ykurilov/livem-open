// Ход консультанта на краях: живое сообщение при отложенном до утра ходе, пауза сотрудника посреди окна пачки, срок вышел посреди хода
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { DEFAULT_CONSULTANT_REPLY, createLiveDialogKit, providerOutage, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { updateSettings } from "../platform/settings";
import { DAILY_LIMIT_TEXT, MODEL_DELAY_TEXT } from "../spending";
import { DECLINED_SILENT_REASON, SILENT_TURN_REASON } from "./turn";
import { passages } from "./schema";

const DAILY_LIMIT_USD = 1;
// 12:00 по Москве 1 октября
const START = new Date("2026-10-01T09:00:00Z");

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { dailyLimitUsd: String(DAILY_LIMIT_USD), monthlyBudgetUsd: null, alertChatId: "777" });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("update app.passages set status = 'not_completed' where status = 'active'");
  kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
  person = `user-${randomUUID().slice(0, 8)}`;
});

async function startPassage() {
  const lead = await kit.publish();
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  return (await kit.passagesOf(person))[0]!;
}

async function say(text: string) {
  await kit.send(person, text);
  await kit.runDue();
  kit.clock.advance(5_000);
  await kit.runDue();
}

describe("отложенный до утра ход и живое сообщение", () => {
  it("до полуночи по Москве лимит держит; после сброса лимита новое сообщение получает ответ, не дожидаясь утра", async () => {
    await startPassage();
    await kit.spend((await kit.personOf(person))!.id, DAILY_LIMIT_USD);
    await say("Вечером");
    expect(kit.consultantCalls()).toHaveLength(0);

    // 23:30 МСК: лимит ещё не сброшен — модель молчит, второго «продолжим завтра» нет
    kit.clock.set(new Date("2026-10-01T20:30:00Z"));
    await say("Ещё до полуночи");
    expect(kit.consultantCalls()).toHaveLength(0);
    expect(kit.textsTo(person).filter((text) => text === DAILY_LIMIT_TEXT)).toHaveLength(1);

    // 00:30 МСК: лимит дня сброшен — человек написал сам, ответ сразу
    kit.clock.set(new Date("2026-10-01T21:30:00Z"));
    await say("После полуночи");
    expect(kit.consultantCalls()).toHaveLength(1);
    expect(kit.consultantCalls()[0]!.lastUserText).toMatch(/Вечером[\s\S]*Ещё до полуночи[\s\S]*После полуночи/);
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
    expect((await kit.inboundOf(person)).every((message) => message.answeredAt !== null)).toBe(true);

    // Утренний ход находит, что отвечать нечего
    await kit.drain();
    expect(kit.consultantCalls()).toHaveLength(1);
  });

  it("ход после сброса лимита упал на сбое провайдера — повтор встаёт, хотя ждёт утренний ход; ответ один", async () => {
    await startPassage();
    await kit.spend((await kit.personOf(person))!.id, DAILY_LIMIT_USD);
    await say("Вечером");
    expect(kit.consultantCalls()).toHaveLength(0);

    // 00:30 МСК: лимит сброшен, но провайдер лежит
    kit.clock.set(new Date("2026-10-01T21:30:00Z"));
    let modelDown = true;
    kit.reply = () => {
      if (modelDown) throw providerOutage();
      return { text: DEFAULT_CONSULTANT_REPLY };
    };
    await say("После полуночи");
    expect(kit.textsTo(person)).not.toContain(DEFAULT_CONSULTANT_REPLY);

    // Провайдер ожил: ответ — с повтором через минуты, а не утром в 9:00
    modelDown = false;
    kit.clock.advance(2 * 60_000);
    await kit.runDue();
    kit.clock.advance(5_000);
    await kit.runDue();
    expect(kit.textsTo(person).filter((text) => text === DEFAULT_CONSULTANT_REPLY)).toHaveLength(1);
    expect((await kit.inboundOf(person)).every((message) => message.answeredAt !== null)).toBe(true);

    // Утренний ход находит, что отвечать нечего: второго ответа нет
    await kit.drain();
    expect(kit.textsTo(person).filter((text) => text === DEFAULT_CONSULTANT_REPLY)).toHaveLength(1);
  });
});

describe("пауза сотрудника посреди окна пачки", () => {
  it("эксперт ответил, пока ход ждал тишины: сообщение — эксперту во «Входящие», а не «отвечено»", async () => {
    await startPassage();
    kit.onBurstRecorded = () => {};
    await kit.send(person, "Вопрос эксперту");
    await kit.runDue();
    await kit.dialog.noteStaffReply({ personId: (await kit.personOf(person))!.id });
    await kit.drain();

    expect(kit.consultantCalls()).toHaveLength(0);
    const [question] = (await kit.inboundOf(person)).filter((message) => message.text === "Вопрос эксперту");
    expect(question).toMatchObject({ route: "inbox", answeredAt: null });
  });
});

describe("срок вышел, пока модель думала", () => {
  it("ответ не уходит, а вопрос человека — эксперту во «Входящие», а не «отвечено»", async () => {
    const passage = await startPassage();
    // Срок программы истёк посреди хода: сценарий закрыл прохождение, пока модель писала ответ
    kit.reply = () => ({
      text: DEFAULT_CONSULTANT_REPLY,
      until: (async () => {
        await kit.db.update(passages).set({ status: "term_ended", endedAt: kit.clock.now() }).where(eq(passages.id, passage.id));
      })(),
    });
    await say("Последний вопрос");
    await kit.drain();

    expect(kit.consultantCalls()).toHaveLength(1);
    expect(kit.textsTo(person)).not.toContain(DEFAULT_CONSULTANT_REPLY);
    const [question] = (await kit.inboundOf(person)).filter((message) => message.text === "Последний вопрос");
    expect(question).toMatchObject({ route: "inbox", answeredAt: null });
  });
});

describe("модель закончила ход без слов", () => {
  it("человеку «отвечу чуть позже», сообщение — эксперту во «Входящие» с тревогой, а не «отвечено»", async () => {
    await startPassage();
    const before = kit.textsTo(person).length;
    kit.reply = () => ({});
    await say("Вопрос без ответа");
    await kit.drain();

    expect(kit.textsTo(person).slice(before)).toEqual([MODEL_DELAY_TEXT]);
    const [question] = (await kit.inboundOf(person)).filter((message) => message.text === "Вопрос без ответа");
    expect(question).toMatchObject({ route: "inbox", answeredAt: null });
    const [passage] = await kit.passagesOf(person);
    expect(passage).toMatchObject({ status: "active", handoverReason: SILENT_TURN_REASON });
    expect(kit.alertTexts.filter((text) => /входящие/i.test(text))).toHaveLength(1);

    // Следующее сообщение — снова консультанту
    kit.reply = () => ({ text: DEFAULT_CONSULTANT_REPLY });
    await say("Ау");
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
  });
});

describe("человек отказался, консультант завершил разговор без слов", () => {
  it("не сбой: ни «отвечу чуть позже», ни тревоги; сообщение — эксперту во «Входящие» с объяснением", async () => {
    await startPassage();
    const before = kit.textsTo(person).length;
    const alertsBefore = kit.alertTexts.length;
    kit.reply = (call) =>
      call.lastToolResult === undefined
        ? { toolCalls: [{ toolName: "finish_dialog", input: { goal: "Цель", stuckAt: "Застрял", chosenStep: "Созвон", outcome: "declined" } }] }
        : {};
    await say("Больше не пишите мне");
    await kit.drain();

    expect(kit.textsTo(person).slice(before)).toEqual([]);
    expect(kit.alertTexts.slice(alertsBefore)).toEqual([]);
    const [question] = (await kit.inboundOf(person)).filter((message) => message.text === "Больше не пишите мне");
    expect(question).toMatchObject({ route: "inbox", answeredAt: null });
    const [passage] = await kit.passagesOf(person);
    expect(passage).toMatchObject({ status: "completed", handoverReason: DECLINED_SILENT_REASON });
  });
});
