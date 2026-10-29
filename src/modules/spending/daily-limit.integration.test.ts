// Дневной лимит на человека: исчерпан — модель молчит, человеку готовый текст, утром разговор продолжается
import { randomUUID } from "node:crypto";
import { createInMemoryChatStorage } from "@ykurilov/agent-chat-core";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { DEFAULT_CONSULTANT_REPLY, createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { createPreviewEndpoint } from "../consultant";
import { passages } from "../conversations/schema";
import { createLeadMagnet, saveDraft } from "../lead-magnets";
import { CABINET_OWNER_ID } from "../platform/cabinet-owner";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel } from "../platform/scripted-model";
import { updateSettings } from "../platform/settings";
import { DAILY_LIMIT_TEXT, morningAfter } from "./daily-limit";
import { saveSpendingSettings } from "./index";

const DAILY_LIMIT_USD = 1;
// 12:00 по Москве; утро следующего дня — 09:00 МСК (06:00 UTC), конец тихих часов цепочки напоминаний
const START = new Date("2026-10-01T09:00:00Z");
const NEXT_MORNING = new Date("2026-10-02T06:00:00Z");

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

/** Сообщение человека и все задачи, срок которых уже пришёл; часы не двигаются дальше склейки сообщений. */
async function say(text: string) {
  await kit.send(person, text);
  await kit.runDue();
  kit.clock.advance(5_000);
  await kit.runDue();
}

async function exhaustDailyLimit() {
  const personRow = await kit.personOf(person);
  await kit.spend(personRow!.id, DAILY_LIMIT_USD);
}

describe("дневной лимит на человека", () => {
  it("лимит исчерпан — модель не вызывается, человек получает готовый текст «продолжим завтра»", async () => {
    await startPassage();
    await exhaustDailyLimit();
    const before = kit.textsTo(person).length;

    await say("У меня ещё вопрос");

    expect(kit.calls).toHaveLength(0);
    expect(kit.textsTo(person).slice(before)).toEqual([DAILY_LIMIT_TEXT]);
    const [inbound] = (await kit.inboundOf(person)).filter((message) => message.text === "У меня ещё вопрос");
    expect(inbound!.answeredAt).toBeNull();
  });

  it("утром ход возобновляется и консультант отвечает на то, что человек написал", async () => {
    await startPassage();
    await exhaustDailyLimit();
    await say("У меня ещё вопрос");

    const morningTurn = kit.queue.pending.find((job) => job.name === "inbound-turn");
    expect(morningTurn?.runAt).toBe(NEXT_MORNING.getTime());

    await kit.drain();
    expect(kit.clock.now().getTime()).toBeGreaterThanOrEqual(NEXT_MORNING.getTime());
    expect(kit.calls).toHaveLength(1);
    expect(kit.calls[0]!.lastUserText).toContain("У меня ещё вопрос");
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
    expect((await kit.inboundOf(person)).every((message) => message.answeredAt !== null)).toBe(true);
  });

  it("ночью человек пишет ещё — второго «продолжим завтра» нет, утром один ход на все сообщения", async () => {
    await startPassage();
    await exhaustDailyLimit();
    await say("Первый вопрос");
    kit.clock.advance(60 * 60_000);
    await say("И второй");

    expect(kit.textsTo(person).filter((text) => text === DAILY_LIMIT_TEXT)).toHaveLength(1);
    expect(kit.calls).toHaveLength(0);

    await kit.drain();
    expect(kit.calls).toHaveLength(1);
    // Вечером лимит не пустил сообщение в историю: утром оба — одной пачкой, модель видит их одним сообщением
    expect(kit.calls[0]!.lastUserText).toMatch(/Первый вопрос\s+И второй/);
    const [passage] = await kit.passagesOf(person);
    expect(passage!.personMessageCount).toBe(2);
  });

  it("цепочка напоминаний не сбрасывается «продолжим завтра»", async () => {
    const started = await startPassage();
    const nextReminderAt = new Date("2026-10-01T16:00:00Z");
    await database.db.update(passages).set({ reminderStep: 2, nextReminderAt }).where(eq(passages.id, started.id));
    await exhaustDailyLimit();

    await say("Вопрос");

    const [passage] = await kit.passagesOf(person);
    expect(passage!.reminderStep).toBe(2);
    expect(passage!.nextReminderAt).toEqual(nextReminderAt);
  });

  it("лимит — у каждого человека свой: расход одного не мешает другому", async () => {
    await startPassage();
    await exhaustDailyLimit();
    await say("Вопрос");
    expect(kit.calls).toHaveLength(0);

    const other = person;
    person = `user-${randomUUID().slice(0, 8)}`;
    const lead = await kit.publish();
    await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
    await kit.runDue();
    await say("Привет");
    expect(kit.calls).toHaveLength(1);
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
    expect(kit.textsTo(other).at(-1)).toBe(DAILY_LIMIT_TEXT);
  });

  it("лимит подняли в настройках — следующий ход идёт сразу", async () => {
    await startPassage();
    await exhaustDailyLimit();
    await updateSettings(database.db, { dailyLimitUsd: "5" });
    try {
      await say("Вопрос");
      expect(kit.calls).toHaveLength(1);
      expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
    } finally {
      await updateSettings(database.db, { dailyLimitUsd: String(DAILY_LIMIT_USD) });
    }
  });
});

describe("подъём лимита в настройках", () => {
  const save = (dailyLimitUsd: string) =>
    saveSpendingSettings(
      { db: database.db, chatStorage: kit.chatStorage, clock: kit.clock, alerts: kit.alerts, queue: kit.queue },
      { dailyLimitUsd },
    );

  afterEach(async () => {
    await updateSettings(database.db, { dailyLimitUsd: String(DAILY_LIMIT_USD) });
  });

  it("отложенный до утра ход идёт сразу, утром второго хода нет", async () => {
    await startPassage();
    await exhaustDailyLimit();
    await say("Вопрос до утра");
    expect(kit.calls).toHaveLength(0);

    await save("5");
    await kit.runDue();
    expect(kit.calls).toHaveLength(1);
    expect(kit.calls[0]!.lastUserText).toContain("Вопрос до утра");
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
    expect((await kit.passagesOf(person))[0]!.dailyLimitPausedAt).toBeNull();

    await kit.drain();
    expect(kit.calls).toHaveLength(1);
  });

  it("лимит снизили — отложенные ходы ждут утра", async () => {
    await startPassage();
    await exhaustDailyLimit();
    await say("Вопрос до утра");

    await save("0.5");
    await kit.runDue();
    expect(kit.calls).toHaveLength(0);
    expect((await kit.passagesOf(person))[0]!.dailyLimitPausedAt).not.toBeNull();
  });
});

describe("утро после лимита", () => {
  it("SDK не назвал время обнуления — полночь по Москве считаем сами", async () => {
    // 01:00 2 октября по Москве: день лимита начался в полночь, обнулится в полночь 3-го, продолжим в 09:00 3-го
    kit.clock.set(new Date("2026-10-01T22:00:00Z"));
    expect(await morningAfter({ db: database.db, clock: kit.clock }, null)).toEqual(new Date("2026-10-03T06:00:00Z"));
  });
});

describe("тестовый разговор эксперта", () => {
  it("дневным лимитом не ограничен", async () => {
    const chatStorage = createInMemoryChatStorage();
    const scripted = createScriptedModel(() => ({ text: "Ответ превью" }));
    const preview = createPreviewEndpoint({
      db: database.db,
      pool: database.pool,
      judgeFallback: STUB_MODEL_CHOICE,
      chatStorage,
      catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
      env: { STUB_MODEL_API_KEY: "test" },
      resolveUser: async () => ({ id: "expert" }),
      modelChoice: () => STUB_MODEL_CHOICE,
    });
    const lead = await createLeadMagnet(database.db, { name: "Превью без лимита" });
    await saveDraft(database.db, lead.id, { ...lead.draft, instruction: "Ты консультант." }, "manual");
    const chatId = await preview.ensurePreview(lead.id);
    await chatStorage.insertUsageRecord({
      id: randomUUID(),
      ownerId: CABINET_OWNER_ID,
      chatId,
      messageId: null,
      source: "answer",
      ...STUB_MODEL_CHOICE,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: DAILY_LIMIT_USD * 10,
      createdAt: new Date().toISOString(),
    });

    const response = await preview.fetch(
      new Request(`http://localhost/api/preview/${chatId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { id: randomUUID(), role: "user", parts: [{ type: "text", text: "Привет" }] } }),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(scripted.calls).toHaveLength(1);
  });
});
