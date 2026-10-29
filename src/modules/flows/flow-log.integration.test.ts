import { randomUUID } from "node:crypto";
import type { FlowTransitionEvent } from "@ykurilov/agent-chat-flows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { listAgentLog } from "../agent-log";
import { previewConversations } from "../consultant/schema";
import { createLeadMagnet, getLeadMagnet } from "../lead-magnets";
import { createFlowLog } from "./flow-log";
import { leadMagnetFlowEvents } from "./events";
import { DEADLINE_STATE_ID } from "./settings-to-flow";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function previewChat() {
  const lead = await createLeadMagnet(database.db, { name: "Лог переходов" });
  const draft = (await getLeadMagnet(database.db, lead.id))!.draft;
  const chatId = randomUUID();
  await database.db.insert(previewConversations).values({ chatId, leadMagnetId: lead.id });
  const log = createFlowLog(database.db, async () => ({ flowId: lead.id, versionId: "v", flow: draft.flow }));
  return { lead, chatId, log, states: draft.flow.states };
}

const at = new Date("2026-10-15T06:00:00Z");
const event = (chatId: string, extra: Partial<FlowTransitionEvent>): FlowTransitionEvent => ({
  ownerId: "cabinet",
  chatId,
  flowId: "lm",
  versionId: "v",
  from: "a",
  to: "b",
  exitId: "x",
  decidedBy: "timer",
  tags: [],
  at: at.getTime(),
  ...extra,
});

describe("«Лог»: переходы сценария", () => {
  it("переход пишется строкой с названиями нод, кто решил, причиной и днём", async () => {
    const { lead, chatId, log, states } = await previewChat();
    const [from, to] = states;
    await log.transition(
      event(chatId, {
        from: from!.id,
        to: to!.id,
        decidedBy: "claim",
        probability: 0.91,
        reason: { kind: "claim", text: "Идея названа" },
        day: { day: 2, totalDays: 3, isLastDay: false, dayStartedAt: at.getTime(), nextDayStartAt: at.getTime() + 86_400_000 },
      }),
    );
    const page = await listAgentLog(database.db, lead.id, { limit: 10 });
    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]).toMatchObject({ agent: "consultant", source: "preview", startedAt: at.toISOString() });
    expect(page.turns[0]!.entries).toEqual([
      { kind: "transition", at: at.toISOString(), durationMs: 0, from: from!.title, to: to!.title, decidedBy: "claim", reason: "Идея названа", probability: 0.91, day: 2, totalDays: 3 },
    ]);
  });

  it("нода без названия в сценарии (удалена) — остаётся её id, а запись не пропадает", async () => {
    const { lead, chatId, log } = await previewChat();
    await log.transition(event(chatId, { from: "removed-1", to: "removed-2", reason: { kind: "timer", text: "нода длится 1 день" } }));
    const [entry] = (await listAgentLog(database.db, lead.id, { limit: 10 })).turns[0]!.entries;
    expect(entry).toMatchObject({ from: "removed-1", to: "removed-2", reason: "нода длится 1 день", decidedBy: "timer" });
  });

  it("чужой чат не пишется и не ломает сценарий", async () => {
    const { lead, log } = await previewChat();
    await log.transition(event("foreign-chat", {}));
    expect((await listAgentLog(database.db, lead.id, { limit: 10 })).turns).toHaveLength(0);
  });

  it("события сценария пишут «Лог» и при «срок вышел», хотя этап прохождения тогда не меняется", async () => {
    const { lead, chatId, log } = await previewChat();
    await leadMagnetFlowEvents(database.db, { log }).onTransition(
      event(chatId, { from: "a", to: DEADLINE_STATE_ID, reason: { kind: "timer", text: "срок вышел" } }),
    );
    const [entry] = (await listAgentLog(database.db, lead.id, { limit: 10 })).turns[0]!.entries;
    expect(entry).toMatchObject({ kind: "transition", reason: "срок вышел" });
  });
});

describe("«Лог»: почему бот написал первым", () => {
  it("все причины одного срока — одной строкой; переход по сроку — с названием ноды", async () => {
    const { lead, chatId, log, states } = await previewChat();
    const node = states[0]!;
    await log.firstMessage({ chatId, reasons: [{ kind: "morning" }, { kind: "transition", stateId: node.id }, { kind: "silence", step: 2 }] });
    const [entry] = (await listAgentLog(database.db, lead.id, { limit: 10 })).turns[0]!.entries;
    expect(entry).toMatchObject({
      kind: "first-message",
      reasons: [{ kind: "morning" }, { kind: "transition", stateTitle: node.title }, { kind: "silence", step: 2 }],
    });
  });

  it("без причин — записи нет", async () => {
    const { lead, chatId, log } = await previewChat();
    await log.firstMessage({ chatId, reasons: [] });
    expect((await listAgentLog(database.db, lead.id, { limit: 10 })).turns).toHaveLength(0);
  });
});
