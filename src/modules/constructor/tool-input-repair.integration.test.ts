// Кривые аргументы правки от модели: недостающую скобку дописывает ядро SDK, changes строкой разбирается, сломанное не пишется
import { createInMemoryChatStorage, type ChatStorage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet, getLeadMagnet, listVersions, saveDraft, type LeadMagnet } from "../lead-magnets";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "../platform/scripted-model";
import recorded from "./recorded/broken-edit-inputs.json";
import brokenStrings from "./recorded/broken-changes-strings.json";
import invalidInputs from "./recorded/invalid-edit-inputs.json";
import { createConstructorEndpoint, type ConstructorEndpoint } from "./index";

let database: TestDatabase;
let chatStorage: ChatStorage;
let endpoint: ConstructorEndpoint;
let lead: LeadMagnet;
let chatId: string;
let toolCall: { inputText: string };
let toolResults: unknown[];

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  chatStorage = createInMemoryChatStorage();
  toolResults = [];
  const scripted = createScriptedModel((call: ScriptedCall): ScriptedReply => {
    if (call.lastToolResult !== undefined) {
      toolResults.push(call.lastToolResult);
      return { text: "Готово." };
    }
    return { toolCalls: [{ toolName: "edit_lead_magnet", ...toolCall }] };
  });
  endpoint = createConstructorEndpoint({
    db: database.db,
    chatStorage,
    catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
    defaultChoice: STUB_MODEL_CHOICE,
    env: { STUB_MODEL_API_KEY: "test" },
    resolveUser: async () => ({ id: "expert" }),
  });
  const created = await createLeadMagnet(database.db, { name: `Скобки ${Math.random()}` });
  await saveDraft(database.db, created.id, { ...created.draft, firstMessage: "Привет!" }, "manual");
  lead = (await getLeadMagnet(database.db, created.id))!;
  chatId = await endpoint.ensureChat(lead.id);
});

async function say(text: string) {
  const response = await endpoint.fetch(
    new Request(`http://localhost/api/constructor/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: `user-${Math.random()}`, role: "user", parts: [{ type: "text", text }] } }),
    }),
  );
  expect(response.status).toBe(200);
  await response.text();
}

const draft = async () => (await getLeadMagnet(database.db, lead.id))!.draft;

describe("кривые аргументы edit_lead_magnet", () => {
  it("забыта «]» у changes — скобка дописана, правка сохранена целиком", async () => {
    toolCall = { inputText: '{"changes": [{"op": "set", "field": "firstMessage", "value": "Здравствуйте!"}, {"op": "set", "field": "farewellMessage", "value": "До встречи!"}}' };
    await say("Поменяй приветствие и прощание");

    expect(await draft()).toMatchObject({ firstMessage: "Здравствуйте!", farewellMessage: "До встречи!" });
    expect(toolResults[0]).toMatchObject({ type: "json", value: { ok: true } });
  });

  // Правка доходит до инструмента разобранной; что она сама по себе верна, проверяет инструмент (у hard-terse-fitness — нет)
  it("записанные аргументы из прогона: забыта «]» у changes — инструмент получает правку целиком", async () => {
    for (const [scenario, inputText] of Object.entries(recorded.inputs)) {
      expect(() => JSON.parse(inputText), scenario).toThrow();
      toolResults = [];
      toolCall = { inputText };
      await say("Сохрани");
      expect(toolResults[0], scenario).toMatchObject({ type: "json", value: { ok: expect.any(Boolean) } });
      expect(JSON.stringify(toolResults[0]), scenario).not.toMatch(/JSON|changes пришёл строкой/);
    }
  });

  it("changes строкой JSON — правка сохранена", async () => {
    toolCall = { inputText: JSON.stringify({ changes: JSON.stringify([{ op: "set", field: "firstMessage", value: "Добрый день!" }]) }) };
    await say("Поменяй приветствие");

    expect((await draft()).firstMessage).toBe("Добрый день!");
  });

  it("changes строкой со сбитыми скобками — лишняя «}» внутри, лишняя в конце, забыта последняя «]» — правка сохранена", async () => {
    const set = (field: string, value: string) => `{"op": "set", "field": "${field}", "value": "${value}"}`;
    const cases = {
      "лишняя «}» внутри": [`[${set("firstMessage", "Раз")}}]`, "Раз"],
      "лишняя «}» в конце": [`[${set("firstMessage", "Два")}]}`, "Два"],
      "забыта «]»": [`[${set("firstMessage", "Три")}`, "Три"],
    } as const;
    for (const [name, [changes, expected]] of Object.entries(cases)) {
      expect(() => JSON.parse(changes), name).toThrow();
      toolCall = { inputText: JSON.stringify({ changes }) };
      await say("Поменяй приветствие");
      expect((await draft()).firstMessage, name).toBe(expected);
    }
  });

  it("записанные changes строкой из прогона 19.10 — инструмент получает правку, а не ошибку разбора", async () => {
    for (const [scenario, changes] of Object.entries(brokenStrings.inputs)) {
      expect(() => JSON.parse(changes), scenario).toThrow();
      toolResults = [];
      toolCall = { inputText: JSON.stringify({ changes }) };
      await say("Сохрани");
      expect(toolResults[0], scenario).toMatchObject({ type: "json", value: { ok: expect.any(Boolean) } });
      expect(JSON.stringify(toolResults[0]), scenario).not.toMatch(/changes пришёл строкой|Invalid input/);
    }
  });

  it("changes строкой, которая не JSON, — модель получает понятную ошибку, версии нет", async () => {
    const versions = (await listVersions(database.db, lead.id)).length;
    toolCall = { inputText: JSON.stringify({ changes: '[{"op": "set", "field": "firstMessage", "value": "Добрый д' }) };
    await say("Поменяй приветствие");

    expect((await draft()).firstMessage).toBe("Привет!");
    expect(await listVersions(database.db, lead.id)).toHaveLength(versions);
    // Строку чинит ядро SDK; не вышло — его короткая ошибка без аргументов целиком
    expect(toolResults[0]).toMatchObject({ type: "error-text", value: expect.stringMatching(/changes.*пришли вызов заново/) });
    expect(JSON.stringify(toolResults[0])).not.toMatch(/Добрый д|Value:/);
  });

  it("обрезанные аргументы не достраиваются: первая из двух правок не сохраняется отдельно", async () => {
    toolCall = { inputText: '{"changes": [{"op": "set", "field": "firstMessage", "value": "Здравствуйте!"}, {"op": "set", "field": "farewell' };
    await say("Поменяй приветствие и прощание");

    expect((await draft()).firstMessage).toBe("Привет!");
  });
});

// Модель получает одну-две строки: какая правка не так и как правильно, без простыни проверки формата и своих же аргументов
describe("неверные правки — короткая подсказка", () => {
  const errorOf = (result: unknown): string => {
    expect(result).toMatchObject({ type: "json", value: { ok: false } });
    const error = (result as { value: { error: string } }).value.error;
    expect(error).not.toMatch(/Invalid input|Type validation|"code"/);
    expect(error.length).toBeLessThan(500);
    return error;
  };
  const edit = async (changes: unknown) => {
    toolResults = [];
    toolCall = { inputText: JSON.stringify({ changes }) };
    await say("Поправь");
    return toolResults[0];
  };

  it("нет такого поля — названо поле и какие есть", async () => {
    const error = errorOf(await edit([{ op: "set", field: "endCondition", value: "Ок" }, { op: "set", field: "ending", value: "Ок" }]));
    expect(error).toMatch(/Правка №2.*«ending».*endCondition/s);
    expect((await draft()).endCondition).not.toBe("Ок");
  });

  it("не тот op — названы существующие", async () => {
    expect(errorOf(await edit([{ op: "add_stage", name: "Аудит" }]))).toMatch(/Правка №1.*«add_stage».*put_state.*set/s);
  });

  it("поля ноды рядом со state — нода целиком внутри state", async () => {
    const state = { id: "call", title: "Созвон", instructions: "Договориться" };
    expect(errorOf(await edit([{ op: "put_state", id: "call", instructions: "Договориться", state }]))).toMatch(/Правка №1.*put_state.*«id».*внутри state/s);
  });

  it("кусок инструкции ноды через field — подсказка про stateId", async () => {
    expect(errorOf(await edit([{ op: "replace_fragment", field: "sale", find: "цена", replace: "цена 12 000" }]))).toMatch(/«sale».*stateId/s);
  });

  it("кусок без field и stateId — названы оба, а не «поле undefined»", async () => {
    const error = errorOf(await edit([{ op: "replace_fragment", find: "цена", replace: "цена 12 000" }]));
    expect(error).toMatch(/нет «field».*stateId/s);
    expect(error).not.toMatch(/undefined/);
  });

  it("записанные неверные правки из прогонов — правка проходит или короткая подсказка", async () => {
    for (const [name, input] of Object.entries(invalidInputs.inputs)) {
      toolResults = [];
      toolCall = { inputText: JSON.stringify(input) };
      await say("Сохрани");
      const result = toolResults[0] as { type: string; value: { ok: boolean; error?: string } };
      expect(result.type, name).toBe("json");
      if (!result.value.ok) {
        expect(result.value.error, name).not.toMatch(/Invalid input|Type validation|"code"/);
        expect(result.value.error!.length, name).toBeLessThan(500);
      }
    }
  });
});
