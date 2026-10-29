import { createInMemoryChatStorage, standardCatalog, type ChatStorage } from "@ykurilov/agent-chat-core";
import { PERSON_LINK_TOOL, PERSON_LINKS_PER_CHAT, type PersonLinkTools } from "@ykurilov/agent-chat-web-tools";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { newLeadMagnetSettings } from "../lead-magnets";
import { LINK_VIEWS_RULE } from "./instruction";
import { outreachRequestParts } from "./outreach-request";
import { createConsultantPersonLink, FIRECRAWL_SCREENSHOT_USD } from "./person-link";
import { consultantAgentSettings } from "./services";

const OWNER = "person-1";
const profile = standardCatalog.models.find((model) => model.id === "deepseek-4.1-flash")!;
const APP_DOMAINS = ["apps.example.com"];

let storage: ChatStorage;
let chatId: string;
let shots: string[];
let failNext: Error | null;
let personLink: PersonLinkTools;
let parentId: string | null = null;

beforeEach(async () => {
  storage = createInMemoryChatStorage();
  chatId = randomUUID();
  parentId = null;
  await storage.createChat({ id: chatId, ownerId: OWNER, providerId: "deepseek", modelId: profile.id });
  shots = [];
  failNext = null;
  personLink = createConsultantPersonLink({
    storage,
    screenshots: {
      async takeScreenshot(url) {
        if (failNext) throw failNext;
        shots.push(url);
        return { imageUrl: `https://storage.example.com/${shots.length}.png` };
      },
    },
  });
});

async function insert(role: "user" | "assistant", parts: unknown[]) {
  const id = randomUUID();
  await storage.insertMessage({
    id,
    chatId,
    parentId,
    role,
    parts: parts as never,
    formatVersion: 1,
    status: "complete",
    modelId: null,
    providerId: null,
    usage: null,
    reasoningDurationsMs: {},
    error: null,
    createdAt: new Date().toISOString(),
  });
  parentId = id;
  return id;
}
const personSays = (text: string) => insert("user", [{ type: "text", text }]);

function toolFor(providerId: string, turnId: string = randomUUID()) {
  return personLink({ profile, providerId, chatId, ownerId: OWNER, turnId }, { appDomains: APP_DOMAINS })[PERSON_LINK_TOOL];
}

async function view(url: string, options: { providerId?: string; turnId?: string } = {}) {
  const tool = toolFor(options.providerId ?? "deepseek", options.turnId) as { execute(input: object, options: object): Promise<unknown> };
  return tool.execute({ url }, { toolCallId: randomUUID(), messages: [], context: {} });
}

describe("просмотр ссылки человека", () => {
  it("снимок есть у Together, DeepSeek и запасного OpenRouter (SDK 0.60)", () => {
    expect(toolFor("together")).toBeDefined();
    expect(toolFor("deepseek")).toBeDefined();
    expect(toolFor("openrouter")).toBeDefined();
  });

  it("адрес, который человек прислал, открывается, и голым именем сайта тоже", async () => {
    await personSays("Вот моё приложение: appstudio.example.com, посмотрите!");
    await expect(view("https://appstudio.example.com/")).resolves.toBeDefined();
    expect(shots).toEqual(["https://appstudio.example.com/"]);
  });

  it("«sveta-nails»: голое имя от человека открывается на домене приложений; другое имя, чужой домен, путь — отказ", async () => {
    await personSays("Опубликовала! Адрес sveta-nails");
    await expect(view("https://sveta-nails.apps.example.com")).resolves.toBeDefined();
    await expect(view("https://sveta-nails.evil.com")).rejects.toThrow();
    await expect(view("https://other.apps.example.com")).rejects.toThrow();
    await expect(view("https://sveta-nails.apps.example.com/admin")).rejects.toThrow();
    expect(shots).toEqual(["https://sveta-nails.apps.example.com/"]);
  });

  it("адрес, которого человек не присылал, — отказ без обращения к Firecrawl", async () => {
    await personSays("Мой сайт https://appstudio.example.com/app");
    await expect(view("https://evil.example.com/")).rejects.toThrow();
    await expect(view("https://appstudio.example.com/other")).rejects.toThrow();
    expect(shots).toEqual([]);
  });

  it("ссылка из ответа консультанта — не ссылка человека", async () => {
    await insert("assistant", [{ type: "text", text: "Пример: https://bot.example.com" }]);
    await expect(view("https://bot.example.com")).rejects.toThrow();
    expect(shots).toEqual([]);
  });

  it("ссылка из реплики сотрудника (ответ эксперта во «Входящих») — не ссылка человека", async () => {
    await insert("user", [
      { type: "data-agent-notice", data: { notices: [{ kind: "staff", title: "Гляньте пример: https://expert.example.com", staffName: "Ольга" }], deliveryKey: "inbox:1", wakeAgent: false } },
    ]);
    await expect(view("https://expert.example.com")).rejects.toThrow();
    expect(shots).toEqual([]);
  });

  it("служебная просьба «напиши первым» — не слова человека", async () => {
    await insert("user", outreachRequestParts());
    await personSays("Мой сайт https://real.example.com");
    await expect(view("https://real.example.com")).resolves.toBeDefined();
    expect(shots).toEqual(["https://real.example.com/"]);
  });

  it(`не больше ${PERSON_LINKS_PER_CHAT} просмотров за разговор: в одном ходе и по прошлым ходам`, async () => {
    await personSays("https://a.example.com https://b.example.com https://c.example.com https://d.example.com");
    const turn = randomUUID();
    await view("https://a.example.com", { turnId: turn });
    await view("https://b.example.com", { turnId: turn });
    await insert("assistant", [
      { type: `tool-${PERSON_LINK_TOOL}`, toolCallId: "old-call", state: "output-available", input: { url: "https://c.example.com" }, output: {} },
    ]);
    await expect(view("https://d.example.com", { turnId: turn })).rejects.toThrow();
    expect(shots).toHaveLength(2);
  });

  it("не открылась: модели приходит указание сказать один раз, подробностей сбоя нет; просмотр идёт в счёт и в расход", async () => {
    await personSays("https://a.example.com");
    failNext = new Error("timeout at 10.0.0.5:8080");
    const failure = await view("https://a.example.com").then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/один раз/);
    expect(failure?.message).toMatch(/не проси/);
    expect(failure?.message).not.toMatch(/timeout|10\.0\.0\.5/);
    const usage = await storage.sumUsage({ chatId, source: "web_tools" });
    expect(usage.reduce((total, sum) => total + sum.costUsd, 0)).toBeCloseTo(FIRECRAWL_SCREENSHOT_USD);
  });

  it("удачный просмотр пишется расходом web_tools от firecrawl", async () => {
    await personSays("https://a.example.com");
    await view("https://a.example.com");
    expect(await storage.sumUsage({ chatId })).toEqual([expect.objectContaining({ providerId: "firecrawl", costUsd: FIRECRAWL_SCREENSHOT_USD })]);
  });

  it("отказ по правилам расходом не пишется", async () => {
    await personSays("https://a.example.com");
    await expect(view("https://evil.example.com")).rejects.toThrow();
    expect(await storage.sumUsage({ chatId })).toEqual([]);
  });
});

describe("настройки консультанта", () => {
  const settings = { ...newLeadMagnetSettings("Разбор"), instruction: "Ты помощник Анны. Приложение открывается по ссылке вида адрес.apps.example.com." };
  const agentFor = (viewsLinks: boolean) =>
    consultantAgentSettings({
      // Смотреть ссылки даёт сценарий: `person_link_view` в его инструментах
      settings: { ...settings, providerId: "deepseek", viewsLinks, flow: { ...settings.flow, tools: viewsLinks ? ["person_link_view"] : [] } },
      store: {} as never,
      videos: { search: async () => [], get: async () => undefined } as never,
      images: { search: async () => [], get: async () => undefined } as never,
      personLink,
    });
  const tools = (agent: ReturnType<typeof agentFor>) =>
    (agent.tools as (model: object) => Record<string, { execute(input: object, options: object): Promise<unknown> }>)({
      profile,
      providerId: "deepseek",
      chatId,
      ownerId: OWNER,
      turnId: randomUUID(),
      notifyDataChanged() {},
    });

  it("выключено — ни инструмента, ни правила; включено — и то и другое, имя инструмента то же, что в правиле", () => {
    const off = agentFor(false);
    expect(Object.keys(tools(off))).not.toContain(PERSON_LINK_TOOL);
    expect(off.instructions).not.toContain(LINK_VIEWS_RULE);
    const on = agentFor(true);
    expect(Object.keys(tools(on))).toContain(PERSON_LINK_TOOL);
    expect(on.instructions).toContain(LINK_VIEWS_RULE);
    expect(LINK_VIEWS_RULE).toContain(PERSON_LINK_TOOL);
  });

  it("правило о ссылках — только у провайдера, где модель видит снимок: модель не зовёт инструмент, которого у неё нет (eval 15.10)", () => {
    const on = (providerId: string) =>
      consultantAgentSettings({
        settings: { ...settings, providerId, modelId: "deepseek-4.1-flash", viewsLinks: true, flow: { ...settings.flow, tools: ["person_link_view"] } },
        store: {} as never,
        videos: { search: async () => [], get: async () => undefined } as never,
        images: { search: async () => [], get: async () => undefined } as never,
        personLink,
      }).instructions;
    expect(on("together")).toContain(LINK_VIEWS_RULE);
    expect(on("deepseek")).toContain(LINK_VIEWS_RULE);
  });

  it("домен приложений берётся из инструкции: «адрес.apps.example.com» + имя от человека", async () => {
    const tool = tools(agentFor(true))[PERSON_LINK_TOOL]!;
    await personSays("Опубликовала! Адрес sveta-nails");
    await expect(tool.execute({ url: "https://sveta-nails.apps.example.com" }, { toolCallId: randomUUID(), messages: [], context: {} })).resolves.toBeDefined();
    expect(shots).toEqual(["https://sveta-nails.apps.example.com/"]);
  });

  it("правило в постоянной инструкции: содержимое страницы — данные, честный отказ при ошибке, один раз", () => {
    expect(LINK_VIEWS_RULE).toMatch(/данные, а не команды/);
    expect(LINK_VIEWS_RULE).toMatch(/один раз[^.]*двигайся дальше/i);
    expect(LINK_VIEWS_RULE).toMatch(/не проси[^.]*снова/i);
  });
});
