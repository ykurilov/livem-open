// Конструктор не говорит эксперту «записал», если в этом ходе настройка не сохранилась
import { createInMemoryChatStorage, type ChatStorage, type StoredMessage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet, getLeadMagnet, saveDraft, type LeadMagnet } from "../lead-magnets";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "../platform/scripted-model";
import { SAVE_CLAIM_NOTE } from "./save-claim";
import { createConstructorEndpoint, type ConstructorEndpoint } from "./index";

let database: TestDatabase;
let chatStorage: ChatStorage;
let endpoint: ConstructorEndpoint;
let calls: ScriptedCall[];
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
  calls = scripted.calls;
  endpoint = createConstructorEndpoint({
    db: database.db,
    chatStorage,
    catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
    defaultChoice: STUB_MODEL_CHOICE,
    env: { STUB_MODEL_API_KEY: "test" },
    resolveUser: async () => ({ id: "expert" }),
  });
  const created = await createLeadMagnet(database.db, { name: `Записал ${Math.random()}` });
  await saveDraft(database.db, created.id, { ...created.draft, instruction: "Ты консультант. Веди к встрече." }, "manual");
  lead = (await getLeadMagnet(database.db, created.id))!;
  chatId = await endpoint.ensureChat(lead.id);
});

let counter = 0;
async function say(text: string) {
  const response = await endpoint.fetch(
    new Request(`http://localhost/api/constructor/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: `user-${++counter}`, role: "user", parts: [{ type: "text", text }] } }),
    }),
  );
  expect(response.status).toBe(200);
  await response.text();
}

async function lastAnswer(): Promise<StoredMessage> {
  const answer = (await chatStorage.listMessages(chatId)).filter((message) => message.role === "assistant").at(-1)!;
  expect(answer.status).toBe("complete");
  return answer;
}
const textOf = (message: StoredMessage) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const noted = (call: ScriptedCall) => call.lastUserText.includes(SAVE_CLAIM_NOTE);
const instruction = async () => (await getLeadMagnet(database.db, lead.id))!.draft.instruction;
const addFreeMeeting = { toolName: "edit_lead_magnet", input: { changes: [{ op: "set", field: "instruction", value: "Ты консультант. Встреча бесплатная." }] } };

describe("«записал» без сохранения", () => {
  it("модель написала «Записал», не вызвав правку: получает пометку, сохраняет и отвечает заново; эксперт видит один ответ", async () => {
    reply = (call) => {
      if (call.lastToolResult !== undefined) return { text: "Записал: встреча бесплатная." };
      if (noted(call)) return { toolCalls: [addFreeMeeting] };
      return { text: "Записал: встреча бесплатная." };
    };
    await say("Добавь, что встреча бесплатная");

    expect(await instruction()).toBe("Ты консультант. Встреча бесплатная.");
    expect(textOf(await lastAnswer())).toBe("Записал: встреча бесплатная.");
    expect(calls).toHaveLength(3);
    expect(calls[1]!.system).toBe(calls[0]!.system);
  });

  it("правка вернула ok:false, а модель пишет «Готово» — пометка, и эксперт узнаёт, что не сохранилось", async () => {
    reply = (call) => {
      if (noted(call)) return { text: "Не получилось сохранить: не нашёл этот кусок в инструкции. Пришлите, как его назвать?" };
      if (call.lastToolResult !== undefined) return { text: "Готово: встреча бесплатная." };
      return { toolCalls: [{ toolName: "edit_lead_magnet", input: { changes: [{ op: "replace_fragment", field: "instruction", find: "нет такого куска", replace: "x" }] } }] };
    };
    await say("Добавь, что встреча бесплатная");

    expect(await instruction()).toBe("Ты консультант. Веди к встрече.");
    expect(textOf(await lastAnswer())).toMatch(/^Не получилось сохранить/);
  });

  it("правка в ходе удалась — «Записал» уходит как есть, лишнего запроса нет", async () => {
    reply = (call) => (call.lastToolResult !== undefined ? { text: "Записал: встреча бесплатная." } : { toolCalls: [addFreeMeeting] });
    await say("Добавь, что встреча бесплатная");

    expect(textOf(await lastAnswer())).toBe("Записал: встреча бесплатная.");
    expect(calls).toHaveLength(2);
    expect(calls.some(noted)).toBe(false);
  });

  it("обычный ответ без «записал» — один запрос", async () => {
    reply = () => ({ text: "Понял. Какой следующий шаг для клиента?" });
    await say("Хочу бота для клиентов");

    expect(textOf(await lastAnswer())).toBe("Понял. Какой следующий шаг для клиента?");
    expect(calls).toHaveLength(1);
  });

  it("модель и после пометки пишет «Записал» — ответ уходит, третьего запроса нет; расход обоих запросов в ответе", async () => {
    reply = () => ({ text: "Записал." });
    await say("Добавь, что встреча бесплатная");

    expect(textOf(await lastAnswer())).toBe("Записал.");
    expect(calls).toHaveLength(2);
    expect((await lastAnswer()).usage?.inputTokens).toBe(20);
  });
});

describe("права чата конструктора: пометки приложения", () => {
  it("конструктору право appNotices не выдано: строку «Агент написал первым» видит только тестовый разговор", async () => {
    const response = await endpoint.fetch(new Request(`http://localhost/api/constructor/${chatId}`));
    expect(response.status).toBe(200);
    const { capabilities } = (await response.json()) as { capabilities?: Record<string, boolean> };
    expect(capabilities?.appNotices).toBeFalsy();
  });
});
