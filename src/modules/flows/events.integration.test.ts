import { randomUUID } from "node:crypto";
import type { FlowFinish, FlowTransitionEvent } from "@ykurilov/agent-chat-flows";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { bots } from "../channels/schema";
import { previewConversations } from "../consultant/schema";
import { passages } from "../conversations/schema";
import { createLeadMagnet, getLeadMagnet } from "../lead-magnets";
import { people } from "../people/schema";
import { leadMagnetFlowEvents } from "./events";
import { FINAL_STATE_ID } from "./settings-to-flow";

let database: TestDatabase;
let botId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  const [bot] = await database.db
    .insert(bots)
    .values({ channel: "telegram", title: "Бот", externalId: "ext", username: "bot", tokenEncrypted: "x", webhookSecret: "s" })
    .returning();
  botId = bot!.id;
});

afterAll(async () => {
  await database.drop();
});

async function newPassage() {
  const lead = await createLeadMagnet(database.db, { name: `Лидмагнит ${randomUUID().slice(0, 4)}` });
  const [person] = await database.db.insert(people).values({ channel: "telegram", botId, externalUserId: randomUUID() }).returning();
  const chatId = randomUUID();
  const [passage] = await database.db
    .insert(passages)
    .values({ personId: person!.id, leadMagnetId: lead.id, snapshotId: (await getLeadMagnet(database.db, lead.id))!.draftVersionId, chatId })
    .returning();
  return passage!;
}

async function passageRow(id: string) {
  const [row] = await database.db.select().from(passages).where(eq(passages.id, id));
  return row!;
}

const at = new Date("2026-10-15T06:00:00Z");

function transition(passage: { chatId: string; personId: string }, extra: Partial<FlowTransitionEvent>): FlowTransitionEvent {
  return {
    ownerId: passage.personId,
    chatId: passage.chatId,
    flowId: "lm",
    versionId: "v",
    from: "idea",
    to: "polish",
    exitId: "idea_days",
    decidedBy: "timer",
    tags: [],
    at: at.getTime(),
    reason: { kind: "timer", text: "нода длится 1 день" },
    ...extra,
  };
}

function finish(passage: { chatId: string; personId: string }, reason: string, extra: Partial<FlowFinish> = {}): FlowFinish {
  return {
    ownerId: passage.personId,
    chatId: passage.chatId,
    flowId: "lm",
    versionId: "v",
    reason,
    day: null,
    state: "polish",
    tags: [],
    run: {} as FlowFinish["run"],
    at,
    ...extra,
  };
}

describe("переходы сценария → прохождение", () => {
  it("переход пишет текущий этап, историю с причиной, кем решено и днём, самый дальний день", async () => {
    const passage = await newPassage();
    await leadMagnetFlowEvents(database.db).onTransition(
      transition(passage, { day: { day: 2, totalDays: 3, isLastDay: false, dayStartedAt: at.getTime(), nextDayStartAt: at.getTime() + 86_400_000 } }),
    );
    const row = await passageRow(passage.id);
    expect(row.currentStageId).toBe("polish");
    expect(row.furthestDay).toBe(2);
    expect(row.stageHistory).toEqual([
      { stageId: "polish", at: at.toISOString(), reason: "нода длится 1 день", by: "day", decidedBy: "timer", day: 2 },
    ]);
  });

  it("заявка агента с подтверждением судьи — переход консультанта с его причиной", async () => {
    const passage = await newPassage();
    await leadMagnetFlowEvents(database.db).onTransition(
      transition(passage, { from: "idea", to: "build", decidedBy: "claim", probability: 0.92, reason: { kind: "claim", text: "Прислал готовый запрос" } }),
    );
    const row = await passageRow(passage.id);
    expect(row.stageHistory).toEqual([{ stageId: "build", at: at.toISOString(), reason: "Прислал готовый запрос", by: "model", decidedBy: "claim", probability: 0.92 }]);
  });

  it("переход в «Итог» этап не меняет: исход пишет конец разговора", async () => {
    const passage = await newPassage();
    await leadMagnetFlowEvents(database.db).onTransition(transition(passage, { to: FINAL_STATE_ID, decidedBy: "event" }));
    const row = await passageRow(passage.id);
    expect(row.currentStageId).toBeNull();
    expect(row.stageHistory).toEqual([]);
  });

  it("тестовый разговор пишет переходы в свою строку", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Превью" });
    const chatId = randomUUID();
    await database.db.insert(previewConversations).values({ chatId, leadMagnetId: lead.id });
    await leadMagnetFlowEvents(database.db).onTransition(transition({ chatId, personId: "cabinet" }, {}));
    const [row] = await database.db.select().from(previewConversations).where(eq(previewConversations.chatId, chatId));
    expect(row!.currentStageId).toBe("polish");
    expect(row!.stageHistory).toHaveLength(1);
  });
});

describe("конец разговора → статус прохождения", () => {
  it.each([
    ["deadline", "term_ended"],
    ["abandoned", "not_completed"],
    ["blocked", "blocked"],
    ["switched", "not_completed"],
    ["final", "completed"],
  ] as const)("%s → %s", async (reason, status) => {
    const passage = await newPassage();
    await leadMagnetFlowEvents(database.db).onFinish(finish(passage, reason, { day: 3 }));
    const row = await passageRow(passage.id);
    expect(row.status).toBe(status);
    expect(row.endedAt).toEqual(at);
    expect(row.furthestDay).toBe(3);
  });

  it("уже законченное прохождение не меняет статус: согласие finish_dialog остаётся", async () => {
    const passage = await newPassage();
    await database.db.update(passages).set({ status: "completed", endedAt: new Date("2026-10-14T10:00:00Z") }).where(eq(passages.id, passage.id));
    await leadMagnetFlowEvents(database.db).onFinish(finish(passage, "final"));
    const row = await passageRow(passage.id);
    expect(row.status).toBe("completed");
    expect(row.endedAt).toEqual(new Date("2026-10-14T10:00:00Z"));
  });

  it("тестовый разговор по сроку отмечается законченным", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Превью срока" });
    const chatId = randomUUID();
    await database.db.insert(previewConversations).values({ chatId, leadMagnetId: lead.id });
    await leadMagnetFlowEvents(database.db).onFinish(finish({ chatId, personId: "cabinet" }, "deadline"));
    const [row] = await database.db.select().from(previewConversations).where(eq(previewConversations.chatId, chatId));
    expect(row!.finishedAt).toEqual(at);
  });
});
