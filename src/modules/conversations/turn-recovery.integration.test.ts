// Ход консультанта на краях: живое сообщение при отложенном до утра ходе и пауза сотрудника посреди окна пачки
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { DEFAULT_CONSULTANT_REPLY, createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { updateSettings } from "../platform/settings";
import { DAILY_LIMIT_TEXT } from "../spending";

const DAILY_LIMIT_USD = 1;
// 12:00 по Москве 1 октября
const START = new Date("2026-10-01T09:00:00Z");

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { dailyLimitUsd: String(DAILY_LIMIT_USD), monthlyBudgetUsd: null });
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
