// Перенос идущих чатов на сценарии (срез S9, plan.md 3.3). Засеянные прохождения старой версии: чат есть в службе чата,
// а за сценарием не закреплён; колонки этапа, напоминаний и дня — как их вела старая версия. Часы подменены.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, outboundOf, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { outboundMessages } from "../channels/schema";
import { passages } from "../conversations/schema";
import { newProgramSettings, type LeadMagnetSettings, type Stage } from "../lead-magnets";
import { people } from "../people/schema";
import { updateSettings } from "../platform/settings";
import { adoptRunningChats } from "./running-chats";

const MSK = (iso: string) => new Date(`${iso}+03:00`);
const MINUTE = 60_000;
// 14:00 по Москве 12 октября: прохождения засеваются в этот день
const START = MSK("2026-10-12T14:00:00");

const STAGES: Stage[] = [
  { id: "idea", name: "Идея", instruction: "Узнай идею.", transitionCondition: "Идея есть", startDay: null, isSale: false },
  { id: "build", name: "Сборка", instruction: "Помоги собрать.", transitionCondition: "Прислал ссылку", startDay: null, isSale: false },
  { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: null, isSale: true },
];

let database: TestDatabase;
let kit: LiveDialogKit;

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
  await database.pool.query("update app.passages set status = 'completed', ended_at = now() where status = 'active'");
  kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
});

type PassageRow = typeof passages.$inferSelect;

/**
 * Прохождение, начатое старой версией: человек пришёл по ссылке, чат с первым сообщением есть в службе чата, но за
 * сценарием не закреплён. Колонки — как их оставила старая версия.
 */
async function legacyPassage(settings: Partial<LeadMagnetSettings>, columns: Partial<PassageRow>): Promise<PassageRow & { user: string }> {
  const user = `user-${randomUUID().slice(0, 8)}`;
  const lead = await kit.publish(settings);
  await kit.send(user, `/start ${lead.code}`, { startCode: lead.code });
  await kit.runDue();
  await kit.dialog.flow.settled();
  const [row] = await kit.passagesOf(user);
  await database.pool.query("delete from agent_chat.flow_chats where chat_id = $1", [row!.chatId]);
  const [seeded] = await kit.db.update(passages).set({ startedAt: START, ...columns }).where(eq(passages.id, row!.id)).returning();
  return { ...seeded!, user };
}

const adopt = (apply: boolean) => adoptRunningChats({ db: kit.db, pool: database.pool, flow: kit.dialog.flow, now: kit.clock.now(), apply });
const pinned = async (chatId: string) => (await database.pool.query("select * from agent_chat.flow_chats where chat_id = $1", [chatId])).rows[0];
const readRun = (row: PassageRow) => kit.dialog.flow.readRun(row.personId, row.chatId);
const firstMessages = async () => (await outboundOf(kit)).filter((row) => row.kind === "outreach" && row.status === "sent");

/** Часы идут шагами до `until`, как обход таймеров работника. */
async function walk(until: Date, stepMs = 5 * MINUTE) {
  while (kit.clock.now() < until) {
    kit.clock.advance(Math.min(stepMs, until.getTime() - kit.clock.now().getTime()));
    await kit.dialog.flow.tick();
    await kit.dialog.flow.settled();
    await kit.runDue();
  }
}

describe("перенос идущих чатов", () => {
  it("без этапов: «посмотреть» ничего не пишет, применение ставит чат в «Разговор» с последними репликами и шагом", async () => {
    const row = await legacyPassage(
      {},
      { lastPersonMessageAt: new Date(START.getTime() + 5 * MINUTE), reminderChainStartedAt: new Date(START.getTime() + 6 * MINUTE), reminderStep: 0 },
    );
    kit.clock.set(new Date(START.getTime() + 10 * MINUTE));

    const plan = await adopt(false);
    expect(plan).toEqual([expect.objectContaining({ passageId: row.id, outcome: "planned", stateId: "conversation" })]);
    expect(await pinned(row.chatId)).toBeUndefined();

    const done = await adopt(true);
    expect(done).toEqual([expect.objectContaining({ passageId: row.id, outcome: "adopted" })]);
    expect(await readRun(row)).toMatchObject({
      state: "conversation",
      startedAt: START.getTime(),
      lastHumanAt: START.getTime() + 5 * MINUTE,
      lastAgentAt: START.getTime() + 6 * MINUTE,
    });
    // Следующее касание — 15 минут тишины от ответа консультанта
    expect(done[0]!.dueAt).toEqual(new Date(START.getTime() + 21 * MINUTE));
  });

  it("с этапами: нода текущего этапа, вход — время перехода в него", async () => {
    const enteredAt = new Date(START.getTime() + 20 * MINUTE);
    const row = await legacyPassage(
      { stages: STAGES },
      {
        currentStageId: "build",
        stageHistory: [
          { stageId: "idea", at: START.toISOString() },
          { stageId: "build", at: enteredAt.toISOString() },
        ],
        lastPersonMessageAt: enteredAt,
        reminderChainStartedAt: enteredAt,
      },
    );
    kit.clock.set(new Date(START.getTime() + 25 * MINUTE));

    await adopt(true);
    expect(await readRun(row)).toMatchObject({ state: "build", enteredAt: enteredAt.getTime(), startedAt: START.getTime() });
  });

  it("с программой во второй день: тот же день и этап у сценария, счёт сообщений дня продолжается", async () => {
    const stages = STAGES.map((stage, index) => ({ ...stage, startDay: index + 1 }));
    const morning = MSK("2026-10-13T09:00:00");
    const row = await legacyPassage(
      { stages, program: { ...newProgramSettings(3), softDailyMessages: 4, hardDailyMessages: 6 }, maxPersonMessages: 100 },
      {
        currentStageId: "build",
        stageHistory: [
          { stageId: "idea", at: START.toISOString() },
          { stageId: "build", at: morning.toISOString(), by: "day" },
        ],
        programStartDate: "2026-10-12",
        lastPersonMessageAt: MSK("2026-10-13T11:00:00"),
        reminderChainStartedAt: MSK("2026-10-13T11:01:00"),
        dayMessageCount: 5,
        dayMessageCountDay: 2,
      },
    );
    kit.clock.set(MSK("2026-10-13T11:30:00"));

    await adopt(true);
    const run = await readRun(row);
    expect(run).toMatchObject({ state: "build", startedAt: MSK("2026-10-12T09:00:00").getTime(), enteredAt: morning.getTime(), day: { day: 2, totalDays: 3 } });
    expect(Object.values(run!.dayCounts ?? {})).toEqual([5]);
  });

  it("молчащий человек получает следующее касание в срок, по одному, а не сразу пачкой", async () => {
    const repliedAt = START;
    const reminderAt = new Date(START.getTime() + 15 * MINUTE);
    const row = await legacyPassage({}, { lastPersonMessageAt: new Date(START.getTime() - MINUTE), reminderChainStartedAt: repliedAt, reminderStep: 1 });
    // Старая версия уже послала напоминание «через 15 минут»
    await kit.db.insert(outboundMessages).values({
      botId: kit.bot.id,
      personId: row.personId,
      passageId: row.id,
      kind: "reminder",
      text: "Как успехи?",
      status: "sent",
      idempotencyKey: `reminder:${row.id}:old`,
      sentAt: reminderAt,
    });
    kit.clock.set(new Date(START.getTime() + 40 * MINUTE));

    const [adopted] = await adopt(true);
    // Шаг «через час» — от напоминания, а не от ответа консультанта
    expect(adopted!.dueAt).toEqual(new Date(reminderAt.getTime() + 60 * MINUTE));
    await walk(new Date(reminderAt.getTime() + 59 * MINUTE));
    expect(await firstMessages()).toEqual([]);

    await walk(new Date(reminderAt.getTime() + 65 * MINUTE));
    expect(await firstMessages()).toHaveLength(1);
    // Ряд «15 минут, час» кончился: дальше — в 19:00, не раньше
    await walk(MSK("2026-10-12T18:55:00"), 15 * MINUTE);
    expect(await firstMessages()).toHaveLength(1);
    await walk(MSK("2026-10-12T19:10:00"));
    expect(await firstMessages()).toHaveLength(2);
  });

  it("повторный запуск ничего не меняет", async () => {
    const row = await legacyPassage({ stages: STAGES }, { currentStageId: "idea", reminderChainStartedAt: START });
    kit.clock.set(new Date(START.getTime() + 5 * MINUTE));
    await adopt(true);
    const before = await pinned(row.chatId);

    kit.clock.advance(MINUTE);
    const again = await adopt(true);
    expect(again).toEqual([expect.objectContaining({ passageId: row.id, outcome: "already" })]);
    expect(await pinned(row.chatId)).toEqual(before);
    expect(await adopt(false)).toEqual([expect.objectContaining({ outcome: "already" })]);
  });

  it("закончившиеся прохождения не трогает; снимок без сценария — в отчёте, без переноса", async () => {
    const ended = await legacyPassage({}, { status: "completed", endedAt: START });
    const noFlow = await legacyPassage({}, {});
    await database.pool.query("update app.lead_magnet_versions set settings = settings - 'flow' where id = $1", [noFlow.snapshotId]);

    const report = await adopt(true);
    expect(report.map((item) => item.passageId)).not.toContain(ended.id);
    expect(report).toEqual([expect.objectContaining({ passageId: noFlow.id, outcome: "no_flow" })]);
    expect(await pinned(noFlow.chatId)).toBeUndefined();
  });

  it("человек написал до переноса — разговор продолжается с его этапа, а не с начала", async () => {
    const row = await legacyPassage(
      { stages: STAGES },
      { currentStageId: "build", stageHistory: [{ stageId: "build", at: START.toISOString() }], reminderChainStartedAt: START },
    );
    kit.clock.set(new Date(START.getTime() + 5 * MINUTE));

    await kit.send(row.user, "Вот ссылка на сборку");
    await kit.runDue();
    kit.clock.advance(5_000);
    await kit.runDue();
    await kit.dialog.flow.settled();

    expect(await readRun(row)).toMatchObject({ state: "build" });
    expect(await adopt(true)).toEqual([expect.objectContaining({ outcome: "already" })]);
  });

  it("пояс человека переносится в сценарий", async () => {
    const row = await legacyPassage({}, { reminderChainStartedAt: START });
    await kit.db.update(people).set({ timeZone: "Asia/Novosibirsk" }).where(eq(people.id, row.personId));
    await adopt(true);
    expect((await pinned(row.chatId)).time_zone).toBe("Asia/Novosibirsk");
  });
});
