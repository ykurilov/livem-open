// Конструктор узнаёт о новых правках ответов консультанта строкой в хвосте хода; начало запроса не меняется
import { createInMemoryChatStorage, type ChatStorage } from "@ykurilov/agent-chat-core";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { listCorrections, unannounced } from "../corrections";
import { seedCorrections } from "../corrections/test-fixtures";
import { createLeadMagnet, getLeadMagnet, type LeadMagnet } from "../lead-magnets";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "../platform/scripted-model";
import { createConstructorEndpoint, saveExpertEdit, type ConstructorEndpoint } from "./index";

let database: TestDatabase;
let chatStorage: ChatStorage;
let endpoint: ConstructorEndpoint;
let calls: ScriptedCall[];
let lead: LeadMagnet;
let nextReply: (call: ScriptedCall) => ScriptedReply;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  chatStorage = createInMemoryChatStorage();
  nextReply = () => ({ text: "Понял." });
  const scripted = createScriptedModel((call) => nextReply(call));
  calls = scripted.calls;
  endpoint = createConstructorEndpoint({
    db: database.db,
    chatStorage,
    catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
    defaultChoice: STUB_MODEL_CHOICE,
    env: { STUB_MODEL_API_KEY: "test" },
    resolveUser: async () => ({ id: "expert" }),
  });
  lead = (await getLeadMagnet(database.db, (await createLeadMagnet(database.db, { name: "Хвост правок" })).id))!;
});

let messageCounter = 0;

async function post(chatId: string, action: string, body: unknown) {
  const response = await endpoint.fetch(
    new Request(`http://localhost/api/constructor/${chatId}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
  await response.text();
}

const send = (chatId: string, text: string) =>
  post(chatId, "messages", { message: { id: `user-${++messageCounter}`, role: "user", parts: [{ type: "text", text }] } });

const seed = (count: number) =>
  seedCorrections(
    database.db,
    lead.id,
    Array.from({ length: count }, (_, index) => ({ originalText: `Было ${index}`, correctedText: `Стало ${index}` })),
  );

const LINE = /Новые правки и ответы эксперта для разбора: (\d+), всего неразобранных: (\d+)\./;

/** Сообщения запроса без служебных пометок провайдера (метки кэша): сравниваются роли и содержимое. */
const plain = (prompt: LanguageModelV4Prompt) => prompt.map(({ role, content }) => ({ role, content }));

describe("строка о новых правках в хвосте хода", () => {
  it("есть, пока есть неупомянутые; после удачного хода правки упомянуты, следующий ход — без строки", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    await seed(2);

    await send(chatId, "Привет");
    expect(calls[0]!.lastUserText).toMatch(LINE);
    expect(calls[0]!.lastUserText.match(LINE)!.slice(1)).toEqual(["2", "2"]);
    expect((await unannounced(database.db, lead.id)).ids).toEqual([]);
    expect((await listCorrections(database.db, lead.id)).every((one) => one.announcedAt !== null)).toBe(true);

    await send(chatId, "Дальше");
    expect(calls[1]!.lastUserText).not.toMatch(LINE);

    await seed(1);
    await send(chatId, "Что нового?");
    expect(calls[2]!.lastUserText.match(LINE)!.slice(1)).toEqual(["1", "3"]);
  });

  it("ответы эксперта и правки клиента из «Поменяемся ролями» считаются вместе с правками «Проверки»", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    await seed(1);
    await seedCorrections(database.db, lead.id, [
      { source: "role_swap", originalText: "Консультант", correctedText: "Эксперт" },
      { source: "role_swap", agentRole: "client", originalText: "Клиент", correctedText: "Клиент иначе" },
    ]);
    await send(chatId, "Привет");
    expect(calls[0]!.lastUserText.match(LINE)!.slice(1)).toEqual(["3", "3"]);
  });

  it("правок нет — строки нет", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    await send(chatId, "Привет");
    expect(calls[0]!.lastUserText).not.toMatch(LINE);
  });

  it("вместе с заметкой о ручной правке: обе в хвосте, обе сняты после хода", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    await seed(1);
    await saveExpertEdit(database.db, lead.id, { settings: { ...lead.draft, firstMessage: "Добрый день!" }, expectedVersionId: lead.draftVersionId });

    await send(chatId, "Посмотри");
    expect(calls[0]!.lastUserText).toMatch(LINE);
    expect(calls[0]!.lastUserText).toContain("Эксперт вручную изменил:");
    expect((await getLeadMagnet(database.db, lead.id))!.pendingManualEdits).toEqual([]);
    expect((await unannounced(database.db, lead.id)).ids).toEqual([]);
  });

  it("ход сорвался — правки не упомянуты; повтор несёт строку и отмечает их", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    const seeded = await seed(2);
    nextReply = () => {
      throw new Error("модель упала");
    };
    await send(chatId, "Разбери правки");
    expect((await unannounced(database.db, lead.id)).ids).toEqual(seeded.map((one) => one.id));

    nextReply = () => ({ text: "Смотрю." });
    await post(chatId, "retry", {});
    expect(calls.at(-1)!.lastUserText).toMatch(LINE);
    expect((await unannounced(database.db, lead.id)).ids).toEqual([]);
  });

  it("системная часть, инструменты и история запроса — те же, что без правок: строка только в самом конце", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    await send(chatId, "Привет");
    await seed(2);
    await send(chatId, "Как дела?");
    await send(chatId, "Дальше");
    const [before, withLine, after] = calls;

    expect(withLine!.system).toBe(before!.system);
    expect(after!.system).toBe(before!.system);
    expect(JSON.stringify(withLine!.options.tools)).toBe(JSON.stringify(before!.options.tools));

    const turn1 = plain(before!.options.prompt);
    const turn2 = plain(withLine!.options.prompt);
    const turn3 = plain(after!.options.prompt);
    // Строка — отдельным последним сообщением, вопрос эксперта перед ней без изменений
    const tail = turn2.at(-1)!;
    expect(JSON.stringify(tail)).toMatch(LINE);
    expect(JSON.stringify(tail)).not.toContain("Как дела?");
    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
    // Следующий ход видит историю без строки: начало запроса то же, кэш цел
    expect(turn3.slice(0, turn2.length - 1)).toEqual(turn2.slice(0, -1));
    expect(JSON.stringify(turn3)).not.toMatch(LINE);
  });
});
