// Файл в чате конструктора (txt, md, pdf) становится базой знаний и сразу подключается к лидмагниту этого чата
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryAttachmentStorage } from "@ykurilov/agent-chat-attachments";
import { createInMemoryChatStorage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createKnowledgeBase, getKnowledgeBases, KNOWLEDGE_MAX_CHARS, listKnowledgeBases } from "../knowledge";
import { createLeadMagnet, getLeadMagnet, saveDraft, type LeadMagnet } from "../lead-magnets";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall } from "../platform/scripted-model";
import { constructorChatsApi, createConstructorEndpoint, createConstructorFiles, createKnowledgeBaseFor, type ConstructorEndpoint } from "./index";

let database: TestDatabase;
let endpoint: ConstructorEndpoint;
let calls: ScriptedCall[];
let lead: LeadMagnet;
let chatId: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  const scripted = createScriptedModel(() => ({ text: "Понял." }));
  calls = scripted.calls;
  endpoint = createConstructorEndpoint({
    db: database.db,
    chatStorage: createInMemoryChatStorage(),
    catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
    defaultChoice: STUB_MODEL_CHOICE,
    env: { STUB_MODEL_API_KEY: "test" },
    resolveUser: async () => ({ id: "expert" }),
    attachments: createConstructorFiles({ db: database.db, storage: createMemoryAttachmentStorage() }),
  });
  lead = await createLeadMagnet(database.db, { name: "Лидмагнит с файлами" });
  const created = await call(constructorChatsApi(lead.id), { method: "POST" });
  chatId = ((await created.json()) as { id: string }).id;
});

const call = (path: string, init: RequestInit = {}) => endpoint.fetch(new Request(`http://localhost${path}`, init));
const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/knowledge", name)));
const utf8 = (text: string) => new TextEncoder().encode(text);

interface Uploaded {
  id: string;
  name: string;
  mediaType: string;
}

async function upload(name: string, bytes: Uint8Array): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([bytes.slice().buffer as ArrayBuffer], name));
  return call(`${constructorChatsApi(lead.id)}/${chatId}/attachments`, { method: "POST", body: form });
}

let messageCounter = 0;
async function send(text: string, files: Uploaded[]): Promise<void> {
  const parts = [{ type: "text", text }, ...files.map((file) => ({ type: "file", url: `attachment:${file.id}`, mediaType: file.mediaType, filename: file.name }))];
  const response = await call(`${constructorChatsApi(lead.id)}/${chatId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { id: `user-${++messageCounter}`, role: "user", parts } }),
  });
  expect(response.status).toBe(200);
  await response.text(); // дочитываем поток: ход закончен
}

async function uploaded(name: string, bytes: Uint8Array): Promise<Uploaded> {
  const response = await upload(name, bytes);
  expect(response.status).toBe(201);
  return (await response.json()) as Uploaded;
}

const lastPrompt = () => JSON.stringify(calls.at(-1)!.options.prompt);
const draftKnowledge = async () => (await getLeadMagnet(database.db, lead.id))!.draft.knowledgeIds ?? [];

describe("файл в чате конструктора — база знаний лидмагнита", () => {
  it("PDF становится базой с его текстом и подключается к лидмагниту; модель видит пометку о базе, а не текст файла", async () => {
    const pdf = await uploaded("Курс.pdf", fixture("курс.pdf"));
    await send("Вот материалы курса", [pdf]);

    const ids = await draftKnowledge();
    expect(ids).toHaveLength(1);
    const [base] = await getKnowledgeBases(database.db, ids);
    expect(base).toMatchObject({ title: "Курс", fileName: "Курс.pdf", content: "Курс длится шесть недель.\nВторая строка про упаковку." });

    const prompt = lastPrompt();
    expect(prompt).toContain("базой знаний «Курс»");
    expect(prompt).toContain("подключён к лидмагниту");
    expect(prompt).not.toContain("Курс длится шесть недель");
  });

  it("txt и md тоже становятся базами; повторный ход не создаёт базу заново, пометка в истории та же", async () => {
    const txt = await uploaded("вопросы.txt", utf8("Сколько длится курс? Шесть недель."));
    const md = await uploaded("отзывы.md", utf8("# Отзывы\nВсё понравилось."));
    await send("Добавь это", [txt, md]);
    const first = lastPrompt();
    await send("Что дальше?", []);

    const bases = await getKnowledgeBases(database.db, await draftKnowledge());
    expect(bases.map((base) => base.title)).toEqual(["вопросы", "отзывы"]);
    expect((await listKnowledgeBases(database.db)).filter((base) => base.usedBy.some((user) => user.id === lead.id))).toHaveLength(2);
    // Начало запроса прошлого хода не изменилось: кэш модели не сбивается
    const second = lastPrompt();
    const marker = /\[Файл «вопросы\.txt»[^\]]*\]/.exec(first)![0];
    expect(second).toContain(marker);
  });

  it("не помещается в предел лидмагнита — база сохраняется, но не подключается; модель знает почему", async () => {
    const big = await createKnowledgeBase(database.db, { title: "Большая" }, { name: "большая.txt", bytes: utf8("я".repeat(KNOWLEDGE_MAX_CHARS - 10)) });
    await saveDraft(database.db, lead.id, { ...lead.draft, knowledgeIds: [big.id] }, "manual");
    const txt = await uploaded("ещё.txt", utf8("Текст длиннее десяти знаков."));
    await send("И это", [txt]);

    expect(await draftKnowledge()).toEqual([big.id]);
    expect((await listKnowledgeBases(database.db)).some((base) => base.title === "ещё")).toBe(true);
    expect(lastPrompt()).toMatch(/не подключён[^\]]*200 000/);
  });

  it("PDF без текста (скан) конструктор не принимает: понятный отказ при загрузке, база не появляется", async () => {
    const before = (await listKnowledgeBases(database.db)).length;
    const response = await upload("скан.pdf", fixture("скан.pdf"));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await listKnowledgeBases(database.db)).length).toBe(before);
  });

  it("картинка остаётся картинкой: база не появляется", async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));
    const image = await uploaded("shot.png", png);
    await send("Посмотри экран", [image]);
    expect(await draftKnowledge()).toEqual([]);
    expect(lastPrompt()).not.toContain("базой знаний");
  });
});

describe("загрузка в разделе «База» с подключением к лидмагнитам", () => {
  it("новая база сразу подключается к выбранным лидмагнитам; конструктор узнаёт об этом заметкой", async () => {
    const second = await createLeadMagnet(database.db, { name: "Второй" });
    const base = await createKnowledgeBaseFor(database.db, { title: "Программа" }, { name: "программа.md", bytes: utf8("Шесть уроков.") }, [lead.id, second.id]);
    for (const id of [lead.id, second.id]) {
      const current = (await getLeadMagnet(database.db, id))!;
      expect(current.draft.knowledgeIds).toEqual([base.id]);
      expect(current.pendingManualEdits.map((note) => note.text).join("\n")).toContain("прикреплена «Программа»");
    }
  });

  it("не помещается в предел одного из лидмагнитов — ничего не сохраняется, ошибка называет лидмагнит", async () => {
    const full = await createLeadMagnet(database.db, { name: "Полный" });
    const big = await createKnowledgeBase(database.db, { title: "Большая" }, { name: "большая.txt", bytes: utf8("я".repeat(KNOWLEDGE_MAX_CHARS - 5)) });
    await saveDraft(database.db, full.id, { ...full.draft, knowledgeIds: [big.id] }, "manual");
    const before = (await listKnowledgeBases(database.db)).length;

    await expect(
      createKnowledgeBaseFor(database.db, { title: "Лишняя" }, { name: "лишняя.txt", bytes: utf8("Слишком длинный текст.") }, [lead.id, full.id]),
    ).rejects.toThrow(/«Полный»[\s\S]*200 000/);
    expect((await listKnowledgeBases(database.db)).length).toBe(before);
    expect(await draftKnowledge()).toEqual([]);
  });

  it("без выбранных лидмагнитов — просто база в разделе", async () => {
    const base = await createKnowledgeBaseFor(database.db, { title: "" }, { name: "заметки.txt", bytes: utf8("Текст.") }, []);
    expect((await listKnowledgeBases(database.db)).find((one) => one.id === base.id)?.usedBy).toEqual([]);
  });
});
