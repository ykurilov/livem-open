import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { previewConversations } from "../consultant/schema";
import { attachConstructorChat, createLeadMagnet } from "../lead-magnets";
import { AGENT_LOG_KEEP_DAYS, createAgentLogRecorder, deleteOldAgentLog, listAgentLog } from "./store";
import type { AgentLogEntry } from "./types";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

function modelEntry(text: string, at = new Date()): AgentLogEntry {
  return {
    kind: "model",
    at: at.toISOString(),
    durationMs: 120,
    providerId: "stub",
    modelId: "stub-v1",
    request: { instructions: "Инструкция", messages: [{ role: "user", parts: [{ type: "text", text }] }], earlierMessages: 0 },
    response: { text: "Ответ", toolCalls: [] },
    usage: { input: 100, output: 10, cacheRead: 80 },
  };
}

describe("хранение журнала агента", () => {
  it("ход конструктора: записан с пометкой агента, читается новым сверху порциями", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Журнал" });
    const chatId = randomUUID();
    await attachConstructorChat(database.db, lead.id, chatId);
    const recorder = createAgentLogRecorder(database.db, {});

    const base = Date.now() - 60_000;
    const turnIds = [0, 1, 2].map(() => randomUUID());
    for (const [index, id] of turnIds.entries()) {
      recorder.startTurn({ id, chatId, startedAt: new Date(base + index * 1000).toISOString() });
      recorder.addEntry(id, modelEntry(`сообщение ${index}`, new Date(base + index * 1000)));
      recorder.addEntry(id, { kind: "tool", at: new Date(base + index * 1000 + 10).toISOString(), durationMs: 5, toolCallId: "c1", name: "edit", input: { a: 1 }, output: "ок" });
    }
    await recorder.flush();

    const firstPage = await listAgentLog(database.db, lead.id, { limit: 2 });
    expect(firstPage.turns.map((turn) => turn.id)).toEqual([turnIds[2], turnIds[1]]);
    expect(firstPage.nextBefore).not.toBeNull();
    expect(firstPage.turns[0]).toMatchObject({ agent: "constructor", source: null, personLabel: null });
    expect(firstPage.turns[0]!.entries.map((entry) => entry.kind)).toEqual(["model", "tool"]);

    const secondPage = await listAgentLog(database.db, lead.id, { limit: 2, before: firstPage.nextBefore! });
    expect(secondPage.turns.map((turn) => turn.id)).toEqual([turnIds[0]]);
    expect(secondPage.nextBefore).toBeNull();
  });

  it("консультант в Проверке и в мессенджере различаются; чужой чат не пишется", async () => {
    const kit = await createLiveDialogKit(database);
    const published = await kit.publish();
    await kit.send("anna", `/start ${published.code}`, { startCode: published.code });
    await kit.drain();
    const [passage] = await kit.passagesOf("anna");

    const previewChatId = randomUUID();
    await database.db.insert(previewConversations).values({ chatId: previewChatId, leadMagnetId: published.leadMagnetId });

    const recorder = createAgentLogRecorder(database.db, {});
    const messengerTurn = randomUUID();
    const previewTurn = randomUUID();
    const strangerTurn = randomUUID();
    recorder.startTurn({ id: messengerTurn, chatId: passage!.chatId, startedAt: new Date(Date.now() - 2000).toISOString() });
    recorder.addEntry(messengerTurn, modelEntry("из мессенджера"));
    recorder.startTurn({ id: previewTurn, chatId: previewChatId, startedAt: new Date(Date.now() - 1000).toISOString() });
    recorder.addEntry(previewTurn, modelEntry("из проверки"));
    recorder.startTurn({ id: strangerTurn, chatId: randomUUID(), startedAt: new Date().toISOString() });
    recorder.addEntry(strangerTurn, modelEntry("ничей"));
    await recorder.flush();

    const { turns } = await listAgentLog(database.db, published.leadMagnetId, { limit: 10 });
    expect(turns.map((turn) => [turn.agent, turn.source])).toEqual([
      ["consultant", "preview"],
      ["consultant", "messenger"],
    ]);
    expect(turns[1]!.personLabel).toBeTruthy();
    expect(turns[1]!.channel).toBe("telegram");
  });

  it("секреты вычищены перед записью", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Секреты" });
    const chatId = randomUUID();
    await attachConstructorChat(database.db, lead.id, chatId);
    const recorder = createAgentLogRecorder(database.db, { PROXY_TOKEN: "very-secret-proxy" });
    const id = randomUUID();
    recorder.startTurn({ id, chatId, startedAt: new Date().toISOString() });
    recorder.addEntry(id, modelEntry("токен very-secret-proxy"));
    await recorder.flush();
    const { turns } = await listAgentLog(database.db, lead.id, { limit: 1 });
    expect(JSON.stringify(turns)).not.toContain("very-secret-proxy");
  });

  it("записи старше 30 дней удаляются", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Чистка" });
    const chatId = randomUUID();
    await attachConstructorChat(database.db, lead.id, chatId);
    const recorder = createAgentLogRecorder(database.db, {});
    const now = new Date();
    const old = randomUUID();
    const fresh = randomUUID();
    recorder.startTurn({ id: old, chatId, startedAt: new Date(now.getTime() - (AGENT_LOG_KEEP_DAYS + 1) * 86_400_000).toISOString() });
    recorder.addEntry(old, modelEntry("старое"));
    recorder.startTurn({ id: fresh, chatId, startedAt: new Date(now.getTime() - 86_400_000).toISOString() });
    recorder.addEntry(fresh, modelEntry("свежее"));
    await recorder.flush();

    expect(await deleteOldAgentLog(database.db, now)).toBe(1);
    const { turns } = await listAgentLog(database.db, lead.id, { limit: 10 });
    expect(turns.map((turn) => turn.id)).toEqual([fresh]);
  });
});
