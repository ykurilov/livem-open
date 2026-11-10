// Английская фраза конструктора перед вызовом инструмента не доходит до эксперта: ни в ленте, ни на экране по ходу ответа
import { createInMemoryChatStorage, type ChatStorage, type StoredMessage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet, getLeadMagnet, saveDraft, type LeadMagnet } from "../lead-magnets";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "../platform/scripted-model";
import { createConstructorEndpoint, type ConstructorEndpoint } from "./index";

let database: TestDatabase;
let chatStorage: ChatStorage;
let endpoint: ConstructorEndpoint;
let lead: LeadMagnet;
let chatId: string;
let reply: (call: ScriptedCall) => ScriptedReply;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  chatStorage = createInMemoryChatStorage();
  const scripted = createScriptedModel((call) => reply(call));
  endpoint = createConstructorEndpoint({
    db: database.db,
    chatStorage,
    catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
    defaultChoice: STUB_MODEL_CHOICE,
    env: { STUB_MODEL_API_KEY: "test" },
    resolveUser: async () => ({ id: "expert" }),
  });
  const created = await createLeadMagnet(database.db, { name: `Чужие слова ${Math.random()}` });
  await saveDraft(database.db, created.id, { ...created.draft, instruction: "Ты консультант. Веди к встрече." }, "manual");
  lead = (await getLeadMagnet(database.db, created.id))!;
  chatId = await endpoint.ensureChat(lead.id);
});

let counter = 0;
/** Сообщение эксперта; возвращает поток ответа как есть — то, что успел бы увидеть браузер. */
async function say(text: string): Promise<string> {
  const response = await endpoint.fetch(
    new Request(`http://localhost/api/constructor/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: `reply-check-${++counter}`, role: "user", parts: [{ type: "text", text }] } }),
    }),
  );
  expect(response.status).toBe(200);
  return response.text();
}

async function lastAnswer(): Promise<StoredMessage> {
  const answer = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
  expect(answer.status).toBe("complete");
  return answer;
}

const englishBeforeTool = "Okay, let me quickly update everything now.";
const russianBeforeTool = "Сейчас я быстро обновлю всё, что нужно.";
const addFreeMeeting = { toolName: "edit_lead_magnet", input: { changes: [{ op: "set", field: "instruction", value: "Ты консультант. Встреча бесплатная." }] } };

describe("проверка ответа конструктора", () => {
  it("английская фраза перед инструментом переписывается и не попадает в поток к эксперту", async () => {
    reply = (call) => {
      if (call.lastUserText.includes("Чужие слова:")) return { text: russianBeforeTool };
      if (call.lastToolResult !== undefined) return { text: "Записал: встреча бесплатная." };
      return { text: englishBeforeTool, toolCalls: [addFreeMeeting] };
    };
    const stream = await say("Добавь, что встреча бесплатная");

    const answer = await lastAnswer();
    expect(answer.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual([russianBeforeTool, "Записал: встреча бесплатная."]);
    expect(answer.parts.some((part) => part.type === "tool-edit_lead_magnet")).toBe(true);
    expect((await getLeadMagnet(database.db, lead.id))!.draft.instruction).toBe("Ты консультант. Встреча бесплатная.");
    // Ответ держится до проверки: исходная фраза не печатается даже на миг
    expect(stream).not.toContain("let me");
    expect(stream).toContain("Сейчас я быстро обновлю");
  });
});
