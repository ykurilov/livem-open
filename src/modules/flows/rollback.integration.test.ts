// Откат на прежнюю версию (срез S9, plan.md раздел 8): идущим чатам — колонки напоминаний и дня старой версии по тому,
// что за это время сделал сценарий. Старый работник найдёт напоминания по `next_reminder_at`. Часы подменены.
import { randomUUID } from "node:crypto";
import type { AgentFlow } from "@ykurilov/agent-chat-flows";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, outboundOf, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { passages } from "../conversations/schema";
import { newProgramSettings, type LeadMagnetSettings, type Stage } from "../lead-magnets";
import { appSettings } from "../platform/schema";
import { readSettings, updateSettings } from "../platform/settings";
import { LEGACY_REMINDER_CHAIN, rollbackRunningChats } from "./rollback";

const MSK = (iso: string) => new Date(`${iso}+03:00`);
const MINUTE = 60_000;
const START = MSK("2026-10-12T14:00:00");

const STAGES: Stage[] = [
  { id: "idea", name: "Идея", instruction: "Узнай идею.", transitionCondition: "Идея есть", startDay: null, isSale: false },
  { id: "build", name: "Сборка", instruction: "Помоги собрать.", transitionCondition: "Прислал ссылку", startDay: 2, isSale: false },
  { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: 3, isSale: true },
];

let database: TestDatabase;
let kit: LiveDialogKit;
let user: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { dailyLimitUsd: "1000", monthlyBudgetUsd: null });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("do $$ begin if to_regclass('agent_chat.flow_chats') is not null then delete from agent_chat.flow_chats; end if; end $$");
  await database.pool.query("update app.passages set status = 'completed', ended_at = now() where status = 'active'");
  await database.db.update(appSettings).set({ reminderChain: null });
  kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
  user = `user-${randomUUID().slice(0, 8)}`;
});

async function start(settings: Partial<LeadMagnetSettings> = {}, adjustFlow?: (flow: AgentFlow) => AgentFlow) {
  const lead = await kit.publish(settings, adjustFlow);
  await kit.send(user, `/start ${lead.code}`, { startCode: lead.code });
  await kit.runDue();
}

async function say(text: string) {
  await kit.send(user, text);
  await kit.runDue();
  kit.clock.advance(5_000);
  await kit.runDue();
  await kit.dialog.flow.settled();
}

async function walk(until: Date, stepMs = 5 * MINUTE) {
  while (kit.clock.now() < until) {
    kit.clock.advance(Math.min(stepMs, until.getTime() - kit.clock.now().getTime()));
    await kit.dialog.flow.tick();
    await kit.dialog.flow.settled();
    await kit.runDue();
  }
}

const passage = async () => (await kit.passagesOf(user))[0]!;
const rollback = (apply: boolean) => rollbackRunningChats({ db: kit.db, pool: database.pool, flow: kit.dialog.flow, clock: kit.clock, apply });
const lastReplyAt = async () => {
  const replies = (await outboundOf(kit)).filter((row) => row.kind === "consultant" && row.status === "sent");
  return new Date(Math.max(...replies.map((row) => row.sentAt!.getTime())));
};
const firstMessages = async () => (await outboundOf(kit)).filter((row) => row.kind === "outreach" && row.status === "sent");

describe("откат на прежнюю версию", () => {
  it("без программы: «посмотреть» ничего не пишет; применение — шаг и срок напоминания по старой цепочке от ответа консультанта", async () => {
    await start();
    await say("Привет, я дизайнер");
    const repliedAt = await lastReplyAt();
    await walk(new Date(repliedAt.getTime() + 16 * MINUTE));
    const [touch] = await firstMessages();
    expect(touch).toBeDefined();
    const before = await passage();

    const plan = await rollback(false);
    expect(plan.chats).toEqual([expect.objectContaining({ passageId: before.id, outcome: "planned" })]);
    expect(plan.reminderChainRestored).toBe(true);
    expect(await passage()).toEqual(before);
    expect((await readSettings(kit.db)).reminderChain).toBeNull();

    const done = await rollback(true);
    expect(done.chats).toEqual([expect.objectContaining({ outcome: "updated" })]);
    // Старая цепочка «15 минут, час» от ответа консультанта: второе — через 45 минут после первого
    expect(await passage()).toMatchObject({ reminderChainStartedAt: repliedAt, reminderStep: 1, nextReminderAt: new Date(touch!.sentAt!.getTime() + 45 * MINUTE) });
    expect((await readSettings(kit.db)).reminderChain).toEqual(LEGACY_REMINDER_CHAIN);
  });

  it("без программы, все касания ряда ушли: следующее — в слот дня, ночью — утром", async () => {
    await start();
    await say("Привет");
    await walk(MSK("2026-10-12T20:00:00"), 15 * MINUTE);
    expect(await firstMessages()).toHaveLength(3);

    await rollback(true);
    expect(await passage()).toMatchObject({ reminderStep: 3, nextReminderAt: MSK("2026-10-13T10:00:00") });
  });

  it("с программой: колонки дня и сообщений первым — по сценарию, срок — сейчас (старая программа пересчитает его сама)", async () => {
    await start({ stages: STAGES, program: newProgramSettings(3), maxPersonMessages: 100 });
    await say("Привет");
    await say("Идея — запись к мастеру");
    await say("И ещё напоминания");
    await walk(new Date(kit.clock.now().getTime() + 16 * MINUTE));
    const [touch] = await firstMessages();
    expect(touch).toBeDefined();

    await rollback(true);
    expect(await passage()).toMatchObject({
      // Сценарий пишет этап только при переходе; пустой старая версия читает как первый этап
      currentStageId: null,
      reminderStep: 1,
      reminderChainStartedAt: touch!.sentAt,
      outreachSentCount: 1,
      outreachDay: 1,
      dayMessageCount: 3,
      dayMessageCountDay: 1,
      nextReminderAt: kit.clock.now(),
    });
  });

  it("начало тишины не уходит назад: колонка старой версии новее исходящих — остаётся, и срок считается от неё", async () => {
    await start();
    const repliedBeforeDeploy = new Date(START.getTime() + 30 * MINUTE);
    const row = await passage();
    await kit.db.update(passages).set({ reminderChainStartedAt: repliedBeforeDeploy }).where(eq(passages.id, row.id));
    kit.clock.set(new Date(START.getTime() + 35 * MINUTE));

    await rollback(true);
    expect(await passage()).toMatchObject({ reminderChainStartedAt: repliedBeforeDeploy, nextReminderAt: new Date(repliedBeforeDeploy.getTime() + 15 * MINUTE) });
  });

  it("повторный запуск ничего не меняет", async () => {
    await start({ stages: STAGES, program: newProgramSettings(3), maxPersonMessages: 100 });
    await say("Привет");
    await rollback(true);
    const after = await passage();

    kit.clock.advance(10 * MINUTE);
    const again = await rollback(true);
    expect(again.chats).toEqual([expect.objectContaining({ outcome: "unchanged" })]);
    expect(again.reminderChainRestored).toBe(false);
    expect(await passage()).toEqual(after);
  });

  it("нода, которой нет среди старых этапов, — в отчёте предупреждение", async () => {
    await start({ stages: STAGES.slice(0, 1) }, (flow) => ({
      ...flow,
      states: flow.states.map((state) => (state.id === "idea" ? { ...state, id: "board-node" } : state)) as AgentFlow["states"],
      start: "board-node",
    }));
    await say("Привет");
    await kit.db.update(passages).set({ currentStageId: "board-node" }).where(eq(passages.id, (await passage()).id));

    const report = await rollback(false);
    expect(report.chats[0]!.warnings).toEqual([expect.stringContaining("board-node")]);
  });

  it("чат, не закреплённый за сценарием, не трогает", async () => {
    await start();
    await say("Привет");
    const row = await passage();
    await database.pool.query("delete from agent_chat.flow_chats where chat_id = $1", [row.chatId]);

    const report = await rollback(true);
    expect(report.chats).toEqual([expect.objectContaining({ outcome: "not_pinned" })]);
    expect(await passage()).toEqual(row);
  });
});
