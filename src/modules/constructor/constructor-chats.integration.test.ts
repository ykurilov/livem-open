// Несколько чатов с конструктором у лидмагнита: список, новый чат с чистой памятью, переименование, удаление
import { createInMemoryChatStorage, loadCurrentBranch, type ChatStorage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { findChatOwner } from "../agent-log/store";
import { CABINET_OWNER_ID } from "../platform/cabinet-owner";
import { recordCorrection } from "../corrections";
import { appendManualEditNotes, createLeadMagnet, findLeadMagnetByConstructorChat, getLeadMagnet, type LeadMagnet } from "../lead-magnets";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall } from "../platform/scripted-model";
import { constructorChatsApi, createConstructorEndpoint, type ConstructorEndpoint } from "./index";

let database: TestDatabase;
let chatStorage: ChatStorage;
let endpoint: ConstructorEndpoint;
let calls: ScriptedCall[];
let lead: LeadMagnet;
let other: LeadMagnet;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  chatStorage = createInMemoryChatStorage();
  const scripted = createScriptedModel(() => ({ text: "Понял." }));
  calls = scripted.calls;
  endpoint = createConstructorEndpoint({
    db: database.db,
    chatStorage,
    catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
    defaultChoice: STUB_MODEL_CHOICE,
    env: { STUB_MODEL_API_KEY: "test" },
    resolveUser: async () => ({ id: "expert" }),
  });
  lead = await createLeadMagnet(database.db, { name: "Чаты конструктора" });
  other = await createLeadMagnet(database.db, { name: "Соседний лидмагнит" });
});

const call = (path: string, init: RequestInit = {}) => endpoint.fetch(new Request(`http://localhost${path}`, init));
const json = (body: unknown): RequestInit => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

interface ListedChat {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

async function listChats(leadMagnetId: string): Promise<ListedChat[]> {
  const response = await call(constructorChatsApi(leadMagnetId));
  expect(response.status).toBe(200);
  return ((await response.json()) as { chats: ListedChat[] }).chats;
}

async function createChat(leadMagnetId: string): Promise<string> {
  const response = await call(constructorChatsApi(leadMagnetId), { method: "POST" });
  expect(response.ok).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

let messageCounter = 0;

/** Сообщение конструктору по адресу списка лидмагнита — так его шлёт панель. */
async function send(leadMagnetId: string, chatId: string, text: string) {
  const response = await call(`${constructorChatsApi(leadMagnetId)}/${chatId}/messages`, {
    method: "POST",
    ...json({ message: { id: `user-${++messageCounter}`, role: "user", parts: [{ type: "text", text }] } }),
  });
  expect(response.status).toBe(200);
  await response.text(); // дочитываем поток: ход закончен
}

const promptOf = (index: number) => JSON.stringify(calls[index]!.options.prompt);

describe("список чатов конструктора", () => {
  it("у лидмагнита без чатов ensureChat заводит первый, и он в списке", async () => {
    expect(await listChats(lead.id)).toEqual([]);
    const first = await endpoint.ensureChat(lead.id);
    expect((await listChats(lead.id)).map((chat) => chat.id)).toEqual([first]);
    expect(await endpoint.ensureChat(lead.id)).toBe(first);
  });

  it("новый чат появляется в списке своего лидмагнита и только в нём", async () => {
    const first = await endpoint.ensureChat(lead.id);
    const second = await createChat(lead.id);
    expect(second).not.toBe(first);
    expect((await listChats(lead.id)).map((chat) => chat.id).sort()).toEqual([first, second].sort());
    expect(await listChats(other.id)).toEqual([]);
    expect((await findLeadMagnetByConstructorChat(database.db, second))?.id).toBe(lead.id);
  });

  it("недавно использованный чат — первым в списке; ensureChat отдаёт его же", async () => {
    const first = await endpoint.ensureChat(lead.id);
    const second = await createChat(lead.id);
    await send(lead.id, second, "Новый разговор");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await send(lead.id, first, "Вернулся к старому");
    expect((await listChats(lead.id)).map((chat) => chat.id)).toEqual([first, second]);
    expect(await endpoint.ensureChat(lead.id)).toBe(first);
  });

  it("две вкладки разом открывают лидмагнит без чатов — заводится один чат", async () => {
    // Создание чата в хранилище не мгновенно: вторая вкладка успевает увидеть пустой список
    const slowStorage: ChatStorage = Object.assign(Object.create(chatStorage) as ChatStorage, {
      createChat: async (...args: Parameters<ChatStorage["createChat"]>) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return chatStorage.createChat(...args);
      },
    });
    const racing = createConstructorEndpoint({
      db: database.db,
      chatStorage: slowStorage,
      catalog: createStubModelCatalog(createAppCatalog({}), createScriptedModel(() => ({ text: "Понял." })).model),
      defaultChoice: STUB_MODEL_CHOICE,
      env: { STUB_MODEL_API_KEY: "test" },
      resolveUser: async () => ({ id: "expert" }),
    });
    const [a, b] = await Promise.all([racing.ensureChat(lead.id), racing.ensureChat(lead.id)]);
    expect(a).toBe(b);
    expect(await listChats(lead.id)).toHaveLength(1);
  });

  it("меню моделей доступно и по адресу лидмагнита: по нему поле ввода узнаёт, принимает ли модель картинки", async () => {
    const response = await call(`${constructorChatsApi(lead.id)}/models`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(endpoint.modelMenu())));
  });

  it("неизвестный лидмагнит — 404; общий список всех чатов владельца закрыт", async () => {
    expect((await call(constructorChatsApi("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
    expect((await call("/api/constructor")).status).toBe(404);
    expect((await call("/api/constructor", { method: "POST" })).status).toBe(404);
  });
});

describe("новый чат — чистая память, тот же лидмагнит", () => {
  it("модель в новом чате не видит прежнюю переписку, но работает с тем же лидмагнитом", async () => {
    const first = await endpoint.ensureChat(lead.id);
    await send(lead.id, first, "Секретное слово — бегемот");
    const second = await createChat(lead.id);
    await send(lead.id, second, "Начнём заново");

    expect(promptOf(0)).toContain("бегемот");
    expect(promptOf(1)).not.toContain("бегемот");
    expect(promptOf(1)).toContain("Начнём заново");
    // Инструменты нового чата правят тот же лидмагнит
    expect(calls[1]!.toolNames).toEqual(calls[0]!.toolNames);
  });

  it("переключение назад: старый чат продолжает свою переписку", async () => {
    const first = await endpoint.ensureChat(lead.id);
    await send(lead.id, first, "Первая тема");
    const second = await createChat(lead.id);
    await send(lead.id, second, "Вторая тема");
    await send(lead.id, first, "Продолжаем первую");

    expect(promptOf(2)).toContain("Первая тема");
    expect(promptOf(2)).not.toContain("Вторая тема");
    const history = await loadCurrentBranch(chatStorage, first);
    expect(history.filter((message) => message.role === "user")).toHaveLength(2);
  });
});

describe("переименование и удаление", () => {
  it("переименование — новое название в списке", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    const response = await call(`${constructorChatsApi(lead.id)}/${chatId}`, { method: "PATCH", ...json({ title: "Про квиз" }) });
    expect(response.status).toBe(200);
    expect((await listChats(lead.id)).find((chat) => chat.id === chatId)?.title).toBe("Про квиз");
  });

  it("удаление убирает чат из списка и переписку из хранилища", async () => {
    const first = await endpoint.ensureChat(lead.id);
    await send(lead.id, first, "Удалим этот разговор");
    const second = await createChat(lead.id);

    expect((await call(`${constructorChatsApi(lead.id)}/${first}`, { method: "DELETE" })).status).toBe(204);
    expect((await listChats(lead.id)).map((chat) => chat.id)).toEqual([second]);
    expect(await chatStorage.getChat(first)).toBeNull();
    expect(await findLeadMagnetByConstructorChat(database.db, first)).toBeNull();
  });

  it("после удаления последнего чата ensureChat заводит новый", async () => {
    const only = await endpoint.ensureChat(lead.id);
    expect((await call(`${constructorChatsApi(lead.id)}/${only}`, { method: "DELETE" })).status).toBe(204);
    expect(await listChats(lead.id)).toEqual([]);
    const fresh = await endpoint.ensureChat(lead.id);
    expect(fresh).not.toBe(only);
    expect((await listChats(lead.id)).map((chat) => chat.id)).toEqual([fresh]);
  });

  it("чат чужого лидмагнита через адрес этого не открыть, не переименовать и не удалить", async () => {
    const foreign = await endpoint.ensureChat(other.id);
    const base = constructorChatsApi(lead.id);
    expect((await call(`${base}/${foreign}`)).status).toBe(404);
    expect((await call(`${base}/${foreign}`, { method: "PATCH", ...json({ title: "Чужой" }) })).status).toBe(404);
    expect((await call(`${base}/${foreign}`, { method: "DELETE" })).status).toBe(404);
    expect(
      (await call(`${base}/${foreign}/messages`, { method: "POST", ...json({ message: { id: "x", role: "user", parts: [{ type: "text", text: "Привет" }] } }) })).status,
    ).toBe(404);
    expect(await chatStorage.getChat(foreign)).not.toBeNull();
    expect((await listChats(other.id)).map((chat) => chat.id)).toEqual([foreign]);
  });
});

describe("прямой адрес чата /api/constructor/<chatId>", () => {
  it("чат, не привязанный к лидмагниту, не открыть, не переименовать и не удалить", async () => {
    const loose = await chatStorage.createChat({ id: "loose-chat", ownerId: CABINET_OWNER_ID, modelId: STUB_MODEL_CHOICE.modelId, providerId: STUB_MODEL_CHOICE.providerId });
    expect((await call(`/api/constructor/${loose.id}`)).status).toBe(404);
    expect((await call(`/api/constructor/${loose.id}`, { method: "PATCH", ...json({ title: "Чужой" }) })).status).toBe(404);
    expect((await call(`/api/constructor/${loose.id}`, { method: "DELETE" })).status).toBe(404);
    expect(await chatStorage.getChat(loose.id)).not.toBeNull();
  });

  it("удаление по прямому адресу отвязывает чат от лидмагнита", async () => {
    const chatId = await endpoint.ensureChat(lead.id);
    expect((await call(`/api/constructor/${chatId}`, { method: "DELETE" })).status).toBe(204);
    expect(await findLeadMagnetByConstructorChat(database.db, chatId)).toBeNull();
    expect(await listChats(lead.id)).toEqual([]);
  });
});

describe("что общее у всех чатов лидмагнита", () => {
  it("заметка о ручной правке уходит в тот чат, где эксперт написал первым, и только один раз", async () => {
    const first = await endpoint.ensureChat(lead.id);
    const second = await createChat(lead.id);
    await appendManualEditNotes(database.db, lead.id, ["Первое сообщение: было «» → стало «Здравствуйте!»"]);

    await send(lead.id, second, "Что нового?");
    expect(calls.at(-1)!.lastUserText).toContain("стало «Здравствуйте!»");
    expect((await getLeadMagnet(database.db, lead.id))!.pendingManualEdits).toEqual([]);

    await send(lead.id, first, "А здесь?");
    expect(calls.at(-1)!.lastUserText).not.toContain("Здравствуйте");
  });

  it("строка о новых правках ответов («Проверка», «Поменяемся ролями») — в открытый чат, куда ушла просьба разобрать", async () => {
    await endpoint.ensureChat(lead.id);
    const second = await createChat(lead.id);
    await recordCorrection(database.db, {
      leadMagnetId: lead.id,
      source: "role_swap",
      agentRole: "consultant",
      chatId: "role-swap-chat",
      editedMessageId: "m-1",
      editedText: "Дорого.",
      correctedMessageId: "c-1",
      correctedText: "От 5000 рублей.",
      reason: null,
      answerKind: "reply",
      context: [{ role: "user", text: "Сколько стоит?" }],
      actions: [],
      draftVersionId: lead.draftVersionId,
    });

    await send(lead.id, second, "Разбери правки ответов консультанта.");
    expect(calls.at(-1)!.lastUserText).toContain("Новые правки и ответы эксперта для разбора: 1");
  });

  it("ходы в двух чатах разом: заметка о ручной правке уходит ровно в один из них", async () => {
    let release!: () => void;
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    const scripted = createScriptedModel((turn) => (turn.lastUserText.includes("Первый") ? { text: "Понял.", until: held } : { text: "Понял." }));
    const parallel = createConstructorEndpoint({
      db: database.db,
      chatStorage,
      catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
      defaultChoice: STUB_MODEL_CHOICE,
      env: { STUB_MODEL_API_KEY: "test" },
      resolveUser: async () => ({ id: "expert" }),
    });
    const first = await parallel.ensureChat(lead.id);
    const secondResponse = await parallel.fetch(new Request(`http://localhost${constructorChatsApi(lead.id)}`, { method: "POST" }));
    const second = ((await secondResponse.json()) as { id: string }).id;
    await appendManualEditNotes(database.db, lead.id, ["Первое сообщение: было «» → стало «Здравствуйте!»"]);
    const post = (chatId: string, text: string) =>
      parallel.fetch(
        new Request(`http://localhost${constructorChatsApi(lead.id)}/${chatId}/messages`, {
          method: "POST",
          ...json({ message: { id: `user-${++messageCounter}`, role: "user", parts: [{ type: "text", text }] } }),
        }),
      );

    const firstTurn = post(first, "Первый ход");
    await expect.poll(() => scripted.calls.length).toBe(1);
    await (await post(second, "Второй ход")).text();
    release();
    await (await firstTurn).text();

    const withNote = scripted.calls.filter((turn) => turn.lastUserText.includes("стало «Здравствуйте!»"));
    expect(withNote).toHaveLength(1);
    expect((await getLeadMagnet(database.db, lead.id))!.pendingManualEdits).toEqual([]);
  });

  it("журнал узнаёт любой чат конструктора лидмагнита", async () => {
    await endpoint.ensureChat(lead.id);
    const second = await createChat(lead.id);
    expect(await findChatOwner(database.db, second)).toMatchObject({ leadMagnetId: lead.id, agent: "constructor" });
  });
});
