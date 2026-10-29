// Сбои модели: несколько подряд — громкая тревога; человек не остаётся без ответа молча, ход повторяется позже
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { DEFAULT_CONSULTANT_REPLY, createLiveDialogKit, providerOutage, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import type { ScriptedReply } from "../platform/scripted-model";
import { updateSettings } from "../platform/settings";
import { MAX_TURN_PROVIDER_FAILURES, MODEL_DELAY_TEXT, MODEL_FAILURES_ALERT_AFTER } from "./model-failures";

const MINUTE = 60_000;

let database: TestDatabase;
let kit: LiveDialogKit;
let modelDown: boolean;
/** Текст ошибки модели; `null` — сбой провайдера. */
let modelError: string | null;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("delete from app.alerts");
  await database.pool.query("delete from app.model_health");
  await database.pool.query("update app.passages set status = 'not_completed' where status = 'active'");
  await updateSettings(database.db, { monthlyBudgetUsd: null, dailyLimitUsd: "1000", alertChatId: "777" });
  kit = await createLiveDialogKit(database, { pricePerMillion: 0 });
  modelDown = false;
  modelError = null;
  kit.reply = (): ScriptedReply => {
    if (modelDown) throw modelError === null ? providerOutage() : new Error(modelError);
    return { text: DEFAULT_CONSULTANT_REPLY };
  };
});

/** Начало разговора без перевода часов: отложенные повторы других ходов не срабатывают раньше времени. */
async function startPassage(person: string) {
  const lead = await kit.publish();
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.runDue();
}

async function say(person: string, text: string) {
  await kit.send(person, text);
  await kit.runDue();
  kit.clock.advance(5_000);
  await kit.runDue();
}

const failedTurns = () => kit.calls.length;
const modelAlerts = () => kit.alertTexts.filter((text) => /модель/i.test(text));
const handoverAlerts = () => kit.alertTexts.filter((text) => /входящие/i.test(text));
const turnJobs = () => kit.queue.pending.filter((job) => job.name === "inbound-turn");

/** Двигает часы к ближайшей задаче и выполняет всё, чей срок пришёл. */
async function nextJob(): Promise<void> {
  const next = kit.queue.nextRunAt();
  if (next === undefined) throw new Error("В очереди нет задач: ход потерялся");
  kit.clock.set(new Date(Math.max(next, kit.clock.now().getTime())));
  await kit.runDue();
}

/** Шаги очереди, пока модель не получит `count` запросов. */
async function untilModelCalls(count: number): Promise<void> {
  for (let guard = 0; kit.calls.length < count; guard++) {
    if (guard > 200) throw new Error(`Модель получила ${kit.calls.length} запросов из ${count}`);
    await nextJob();
  }
}

describe("сбои модели", () => {
  it(`${MODEL_FAILURES_ALERT_AFTER} сбоя подряд — громкая тревога, одна на серию`, async () => {
    const person = `user-${randomUUID().slice(0, 8)}`;
    await startPassage(person);
    modelDown = true;
    await say(person, "Привет");
    await untilModelCalls(MODEL_FAILURES_ALERT_AFTER - 1);
    expect(modelAlerts()).toHaveLength(0);

    await untilModelCalls(MODEL_FAILURES_ALERT_AFTER);
    expect(modelAlerts()).toHaveLength(1);

    await untilModelCalls(MODEL_FAILURES_ALERT_AFTER + 2);
    expect(modelAlerts()).toHaveLength(1);
  });

  it("человек не остаётся без ответа молча: короткое «отвечу чуть позже» один раз, потом ответ консультанта", async () => {
    const person = `user-${randomUUID().slice(0, 8)}`;
    await startPassage(person);
    const before = kit.textsTo(person).length;
    modelDown = true;
    await say(person, "Сколько стоит?");
    await untilModelCalls(5);

    expect(kit.textsTo(person).slice(before)).toEqual([MODEL_DELAY_TEXT]);

    modelDown = false;
    await untilModelCalls(6);
    await kit.runDue();
    expect(kit.calls.at(-1)!.lastUserText).toContain("Сколько стоит?");
    expect(kit.textsTo(person).slice(before)).toEqual([MODEL_DELAY_TEXT, DEFAULT_CONSULTANT_REPLY]);
    expect((await kit.inboundOf(person)).every((message) => message.answeredAt !== null)).toBe(true);
  });

  it("модель лежит долго: ход не теряется после многих сбоев и повторяется всё реже", async () => {
    const person = `user-${randomUUID().slice(0, 8)}`;
    await startPassage(person);
    modelDown = true;
    await say(person, "Вопрос");
    const startedAt = kit.clock.now().getTime();
    await untilModelCalls(12);
    expect(failedTurns()).toBe(12);
    // Повторы с нарастающей паузой: двенадцать попыток растягиваются больше чем на два часа
    expect(kit.clock.now().getTime() - startedAt).toBeGreaterThan(2 * 60 * MINUTE);
    const retry = kit.queue.pending.find((job) => job.name === "inbound-turn");
    expect(retry).toBeDefined();
    expect(retry!.runAt - kit.clock.now().getTime()).toBeLessThanOrEqual(30 * MINUTE);

    modelDown = false;
    await kit.drain();
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
  });

  it("сбои у разных людей складываются в одну серию", async () => {
    modelDown = true;
    for (let index = 0; index < MODEL_FAILURES_ALERT_AFTER; index++) {
      const person = `user-${randomUUID().slice(0, 8)}`;
      modelDown = false;
      await startPassage(person);
      modelDown = true;
      await say(person, "Привет");
    }
    expect(failedTurns()).toBe(MODEL_FAILURES_ALERT_AFTER);
    expect(modelAlerts()).toHaveLength(1);
  });

  it("удачный ход обрывает серию: следующая серия сбоев снова даёт тревогу", async () => {
    const person = `user-${randomUUID().slice(0, 8)}`;
    await startPassage(person);
    modelDown = true;
    await say(person, "Раз");
    await untilModelCalls(MODEL_FAILURES_ALERT_AFTER);
    expect(modelAlerts()).toHaveLength(1);

    modelDown = false;
    await kit.drain();
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);

    modelDown = true;
    await say(person, "Два");
    const calls = kit.calls.length;
    await untilModelCalls(calls + MODEL_FAILURES_ALERT_AFTER - 1);
    expect(modelAlerts()).toHaveLength(2);
  });

  it("сбой без тревоги, если серия короче порога", async () => {
    const person = `user-${randomUUID().slice(0, 8)}`;
    await startPassage(person);
    modelDown = true;
    await say(person, "Привет");
    modelDown = false;
    await kit.drain();
    expect(modelAlerts()).toHaveLength(0);
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
  });
});

describe("ошибка не провайдера", () => {
  it("не повторяется по кругу: разговор уходит во «Входящие», тревога про этот разговор, «Модель не отвечает» нет", async () => {
    modelError = "Запрос отклонён: недопустимое содержимое";
    for (let index = 0; index < MODEL_FAILURES_ALERT_AFTER; index++) {
      const person = `user-${randomUUID().slice(0, 8)}`;
      await startPassage(person);
      const before = kit.textsTo(person).length;
      modelDown = true;
      await say(person, "Привет");
      modelDown = false;

      expect(turnJobs()).toHaveLength(0);
      // Человек не остаётся без ответа молча
      expect(kit.textsTo(person).slice(before)).toEqual([MODEL_DELAY_TEXT]);
      const [inbound] = (await kit.inboundOf(person)).filter((message) => message.text === "Привет");
      expect(inbound).toMatchObject({ route: "inbox", answeredAt: null });
      const [passage] = await kit.passagesOf(person);
      expect(passage!.handedToExpertAt).not.toBeNull();
      // Причина для эксперта — по виду ошибки: текст ошибки SDK не хранит
      expect(passage!.handoverReason).toMatch(/отклонил запрос/);
    }
    expect(failedTurns()).toBe(MODEL_FAILURES_ALERT_AFTER);
    expect(handoverAlerts()).toHaveLength(MODEL_FAILURES_ALERT_AFTER);
    expect(modelAlerts()).toHaveLength(0);
  });

  it("длинный контекст — тоже не сбой провайдера", async () => {
    modelError = "This model's maximum context length is 1000 tokens. However, your messages resulted in 5000 tokens";
    const person = `user-${randomUUID().slice(0, 8)}`;
    await startPassage(person);
    modelDown = true;
    await say(person, "Длинный рассказ");
    expect(turnJobs()).toHaveLength(0);
    const [passage] = await kit.passagesOf(person);
    expect(passage!.handoverReason).toMatch(/слишком длинным/);
    expect(handoverAlerts()).toHaveLength(1);
    expect(modelAlerts()).toHaveLength(0);
  });
});

describe("потолок повторов", () => {
  it(`после ${MAX_TURN_PROVIDER_FAILURES} сбоев провайдера (меньше суток) ход больше не повторяется — разговор во «Входящих»`, async () => {
    const person = `user-${randomUUID().slice(0, 8)}`;
    await startPassage(person);
    modelDown = true;
    await say(person, "Вопрос");
    const startedAt = kit.clock.now().getTime();
    await untilModelCalls(MAX_TURN_PROVIDER_FAILURES);

    expect(kit.clock.now().getTime() - startedAt).toBeLessThan(24 * 60 * MINUTE);
    expect(turnJobs()).toHaveLength(0);
    expect(handoverAlerts()).toHaveLength(1);
    const [inbound] = (await kit.inboundOf(person)).filter((message) => message.text === "Вопрос");
    expect(inbound!.route).toBe("inbox");
    const [passage] = await kit.passagesOf(person);
    expect(passage).toMatchObject({ status: "active", turnFailures: 0 });
    expect(passage!.handedToExpertAt).not.toBeNull();
    expect(kit.textsTo(person).filter((text) => text === MODEL_DELAY_TEXT)).toHaveLength(1);
  });
});

describe("потерянная задача хода", () => {
  it("сообщение без ответа и без задачи подбирает подмётчик", async () => {
    const person = `user-${randomUUID().slice(0, 8)}`;
    await startPassage(person);
    await kit.send(person, "Есть кто?");
    await kit.runDue();
    // Задача хода пропала (например, исчерпала повторы очереди при недоступной базе)
    kit.queue.pending.splice(0, kit.queue.pending.length);

    kit.clock.advance(15 * MINUTE);
    await kit.dialog.sweepStuck();
    await kit.drain();
    expect(kit.calls.at(-1)!.lastUserText).toContain("Есть кто?");
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
  });
});
