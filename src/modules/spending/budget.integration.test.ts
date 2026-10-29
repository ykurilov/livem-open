// Месячный бюджет: тревоги 50/80/100%, ежечасный повтор после 100%, аварийная остановка на 200%
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { DEFAULT_CONSULTANT_REPLY, createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { CABINET_OWNER_ID } from "../platform/cabinet-owner";
import { updateSettings } from "../platform/settings";
import { BUDGET_PAUSE_TEXT, acknowledgeBudgetOverrun, readSpendingOverview, recordModelUsage } from "./index";

const BUDGET_USD = 10;
const MINUTE = 60_000;
// 12:00 по Москве, середина месяца
const START = new Date("2026-10-15T09:00:00Z");

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("delete from app.alerts");
  await database.pool.query("delete from app.model_usage");
  await database.pool.query("update app.passages set status = 'not_completed' where status = 'active'");
  await updateSettings(database.db, { monthlyBudgetUsd: String(BUDGET_USD), dailyLimitUsd: "1000", alertChatId: "777" });
  kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
  person = `user-${randomUUID().slice(0, 8)}`;
});

const check = () => kit.dialog.checkBudget();
const overview = () => readSpendingOverview({ db: database.db, chatStorage: kit.chatStorage, clock: kit.clock });

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

describe("месячный бюджет", () => {
  it("расход месяца считается по Москве: журнал SDK, включая тестовые разговоры, и запросы мимо SDK", async () => {
    await kit.spend("someone", 2);
    await kit.spend(CABINET_OWNER_ID, 1);
    await recordModelUsage(database.db, { kind: "reminder_text", passageId: null, costUsd: 0.5, at: kit.clock.now() });
    // Расход прошлого месяца по Москве: 30 сентября 23:30 МСК
    kit.clock.set(new Date("2026-09-30T20:30:00Z"));
    await kit.spend("someone", 100);
    await recordModelUsage(database.db, { kind: "reminder_text", passageId: null, costUsd: 100, at: kit.clock.now() });
    kit.clock.set(START);

    const status = await check();
    expect(status.spentUsd).toBeCloseTo(3.5, 6);
    expect(status.budgetUsd).toBe(BUDGET_USD);
    expect(status.share).toBeCloseTo(0.35, 6);
    expect(status.emergencyStopped).toBe(false);
  });

  it("тревоги на 50%, 80% и 100% — по одной на порог за месяц", async () => {
    await kit.spend("someone", 5);
    await check();
    await check();
    expect(kit.alertTexts).toHaveLength(1);
    expect(kit.alertTexts[0]).toContain("50%");

    await kit.spend("someone", 3);
    await check();
    await check();
    expect(kit.alertTexts).toHaveLength(2);
    expect(kit.alertTexts[1]).toContain("80%");

    await kit.spend("someone", 2);
    await check();
    expect(kit.alertTexts).toHaveLength(3);
    expect(kit.alertTexts[2]).toContain("100%");
  });

  it("тестовые разговоры эксперта идут в месячный бюджет", async () => {
    await kit.spend(CABINET_OWNER_ID, 5);
    await check();
    expect(kit.alertTexts).toHaveLength(1);
    expect(kit.alertTexts[0]).toContain("50%");
  });

  it("бюджет проверяется после каждого хода консультанта", async () => {
    await startPassage();
    await kit.spend("someone", 5.5);
    await say("Привет");
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
    expect(kit.alertTexts).toHaveLength(1);
    expect(kit.alertTexts[0]).toContain("50%");
  });

  it("после 100% бот работает, тревога повторяется раз в час, пока эксперт не нажал «вижу»", async () => {
    await startPassage();
    await kit.spend("someone", 10.5);
    await check();
    const after100 = kit.alertTexts.length;

    await say("Ещё вопрос");
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);

    kit.clock.advance(30 * MINUTE);
    await check();
    expect(kit.alertTexts).toHaveLength(after100);

    kit.clock.advance(31 * MINUTE);
    await check();
    expect(kit.alertTexts).toHaveLength(after100 + 1);
    expect(kit.alertTexts.at(-1)).toContain("100%");

    expect((await overview()).overrunAwaitingAck).toBe(true);
    await acknowledgeBudgetOverrun(kit.alerts);
    expect((await overview()).overrunAwaitingAck).toBe(false);
    kit.clock.advance(3 * 60 * MINUTE);
    await check();
    expect(kit.alertTexts).toHaveLength(after100 + 1);
  });

  it("плашка «тревога повторяется раз в час» — только пока достигнуты именно 100%, не 200%", async () => {
    await kit.spend("someone", 10.5);
    await check();
    expect((await overview()).overrunAwaitingAck).toBe(true);

    await kit.spend("someone", 10);
    await check();
    expect(await overview()).toMatchObject({ emergencyStopped: true, overrunAwaitingAck: false });
  });

  it("остановленными считаются только идущие разговоры", async () => {
    await startPassage();
    await kit.spend("someone", 20);
    await check();
    await say("Вопрос");
    expect((await overview()).pausedPassages).toBe(1);

    await database.pool.query("update app.passages set status = 'not_completed' where status = 'active'");
    expect((await overview()).pausedPassages).toBe(0);
  });

  it("подъём бюджета прекращает повтор, а новое превышение снова даёт тревогу", async () => {
    await kit.spend("someone", 10);
    await check();
    const count = kit.alertTexts.length;

    await updateSettings(database.db, { monthlyBudgetUsd: "40" });
    await check();
    kit.clock.advance(2 * 60 * MINUTE);
    await check();
    expect(kit.alertTexts).toHaveLength(count);

    await kit.spend("someone", 30);
    await check();
    expect(kit.alertTexts.at(-1)).toContain("100%");
  });

  it("без бюджета в настройках тревог нет и остановки нет", async () => {
    await updateSettings(database.db, { monthlyBudgetUsd: null });
    await kit.spend("someone", 1000);
    const status = await check();
    expect(status.share).toBeNull();
    expect(status.emergencyStopped).toBe(false);
    expect(kit.alertTexts).toHaveLength(0);
  });
});

describe("аварийная остановка на 200%", () => {
  it("консультант не вызывается, человек один раз получает «отвечу чуть позже»; после подъёма бюджета бот пишет ему первым", async () => {
    await startPassage();
    await kit.spend("someone", 20);
    const status = await check();
    expect(status.emergencyStopped).toBe(true);
    expect(kit.alertTexts.at(-1)).toMatch(/200%|аварийн/i);

    const before = kit.textsTo(person).length;
    await say("Ответьте, пожалуйста");
    kit.clock.advance(10 * MINUTE);
    await say("Алло?");
    await kit.drain();
    expect(kit.calls).toHaveLength(0);
    // Готовый текст без модели, один раз за остановку, сколько бы человек ни писал
    expect(kit.textsTo(person).slice(before)).toEqual([BUDGET_PAUSE_TEXT]);
    const [paused] = await kit.passagesOf(person);
    expect(paused!.status).toBe("active");
    expect(paused!.budgetPausedAt).not.toBeNull();
    expect(await overview()).toMatchObject({ emergencyStopped: true, pausedPassages: 1 });

    await updateSettings(database.db, { monthlyBudgetUsd: "50" });
    const resumed = await check();
    expect(resumed.emergencyStopped).toBe(false);
    await kit.drain();

    expect(kit.calls).toHaveLength(1);
    expect(kit.calls[0]!.lastUserText).toContain("Ответьте, пожалуйста");
    expect(kit.calls[0]!.lastUserText).toContain("Алло?");
    expect(kit.textsTo(person).slice(before)).toEqual([BUDGET_PAUSE_TEXT, DEFAULT_CONSULTANT_REPLY]);
    const [after] = await kit.passagesOf(person);
    expect(after!.budgetPausedAt).toBeNull();
    expect((await overview()).pausedPassages).toBe(0);
  });

  it("новая остановка — новый «отвечу чуть позже»", async () => {
    await startPassage();
    await kit.spend("someone", 20);
    await check();
    const before = kit.textsTo(person).length;
    await say("Первый раз");
    await updateSettings(database.db, { monthlyBudgetUsd: "50" });
    await check();
    await kit.drain();

    await kit.spend("someone", 90);
    await check();
    kit.clock.advance(MINUTE);
    await say("Второй раз");
    expect(kit.textsTo(person).slice(before)).toEqual([BUDGET_PAUSE_TEXT, DEFAULT_CONSULTANT_REPLY, BUDGET_PAUSE_TEXT]);
  });

  it("ход без неотвеченных сообщений не помечает разговор остановленным", async () => {
    const passage = await startPassage();
    await kit.spend("someone", 20);
    await check();
    const before = kit.textsTo(person).length;

    await kit.dialog.runTurn(passage.id);

    const [after] = await kit.passagesOf(person);
    expect(after!.budgetPausedAt).toBeNull();
    expect(kit.textsTo(person)).toHaveLength(before);
    expect((await overview()).pausedPassages).toBe(0);
  });

  it("тревога об остановке приходит один раз за месяц", async () => {
    await kit.spend("someone", 25);
    await check();
    await check();
    expect(kit.alertTexts.filter((text) => /аварийн/i.test(text))).toHaveLength(1);
  });

  it("в новом месяце по Москве расход обнуляется и остановленным людям бот пишет первым", async () => {
    await startPassage();
    await kit.spend("someone", 20);
    await check();
    await say("Вы тут?");
    expect(kit.calls).toHaveLength(0);

    kit.clock.set(new Date("2026-10-31T21:05:00Z")); // 00:05 1 ноября по Москве
    const status = await check();
    expect(status.spentUsd).toBe(0);
    await kit.drain();
    expect(kit.calls).toHaveLength(1);
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
  });
});
