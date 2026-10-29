import type { ToolSet } from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { leadMagnetToFlow } from "../flows/settings-to-flow";
import { createLeadMagnet, newLeadMagnetSettings, newProgramSettings, type LeadMagnetSettings } from "../lead-magnets";
import { createField, type FieldDefinition } from "../people";
import { CONSULTANT_TOOL_NAMES, createConsultantTools } from "./tools";
import { createPreviewConversationStore, readPreviewConversation, startPreviewConversation } from "./preview-store";
import { createShortLinkStore } from "../text-links/server";

let database: TestDatabase;
let chatId: string;
let settings: LeadMagnetSettings;
let niche: FieldDefinition;
let ready: FieldDefinition;
let tools: ToolSet;

beforeAll(async () => {
  database = await createTestDatabase();
  niche = await createField(database.db, { name: "Ниша", type: "text", description: "Чем занимается" });
  ready = await createField(database.db, { name: "Готов к созвону", type: "boolean", description: "Да/нет" });
});

afterAll(async () => {
  await database.drop();
});

let counter = 0;

beforeEach(async () => {
  const lead = await createLeadMagnet(database.db, { name: "Консультант" });
  const old = {
    ...newLeadMagnetSettings("Консультант"),
    stages: [
      { id: "intro", name: "Знакомство", instruction: "Узнай имя", transitionCondition: "Имя известно", startDay: null, isSale: false },
      { id: "goal", name: "Цель", instruction: "Узнай цель", transitionCondition: "Цель названа", startDay: null, isSale: false },
    ],
    fieldIds: [niche.id, ready.id],
  };
  settings = { ...old, flow: leadMagnetToFlow(old, [niche, ready]) };
  chatId = `preview-${++counter}`;
  await startPreviewConversation(database.db, { chatId, leadMagnetId: lead.id });
  tools = createConsultantTools({ store: createPreviewConversationStore(database.db), chatId, settings, saleDay: async () => 1 });
});

const callOptions = { toolCallId: "call", messages: [] } as never;

async function run(name: string, input: unknown) {
  return tools[name]!.execute!(input as never, callOptions) as Promise<{ ok: boolean; error?: string }>;
}

describe("инструменты консультанта", () => {
  it("без «Продажи» — только finish_dialog: переходы, память, пояс и попутные задачи — инструменты сценария SDK", () => {
    expect([...CONSULTANT_TOOL_NAMES].sort()).toEqual(["finish_dialog", "payment_check", "payment_promised", "sale_answer", "text_link"]);
    expect(Object.keys(tools)).toEqual(["finish_dialog"]);
  });

  it("ссылка с подставленным текстом в настройках — инструмент text_link; без неё инструмента нет", async () => {
    expect(tools).not.toHaveProperty("text_link");
    const textLink = { template: "https://appstudio.example.com/?idea={text}&type={type}", types: ["game"], maxTextLength: 450 };
    const withLink = createConsultantTools({ store: createPreviewConversationStore(database.db), chatId, settings: { ...settings, textLink }, saleDay: async () => 1 });
    const output = await withLink.text_link!.execute!({ text: "Кот", type: "game" }, callOptions);
    expect(output).toMatchObject({ ok: true, link: "https://appstudio.example.com/?idea=%D0%9A%D0%BE%D1%82&type=game" });
    expect(CONSULTANT_TOOL_NAMES).toContain("text_link");

    // С публичным адресом приложения модель получает короткую ссылку, а полная лежит у нас
    const shortLinks = createShortLinkStore(database.db, "https://lm.example.ru");
    const short = createConsultantTools({ store: createPreviewConversationStore(database.db, shortLinks), chatId, settings: { ...settings, textLink }, saleDay: async () => 1 });
    const shortOutput = (await short.text_link!.execute!({ text: "Кот", type: "game" }, callOptions)) as { link: string };
    expect(shortOutput.link).toMatch(/^https:\/\/lm\.example\.ru\/i\/[A-Za-z0-9]{7}$/);
    expect(await shortLinks.lookup(shortOutput.link.split("/i/")[1]!)).toMatchObject({ target: "https://appstudio.example.com/?idea=%D0%9A%D0%BE%D1%82&type=game" });
  });

  it("finish_dialog пишет итог и завершает тестовый разговор", async () => {
    const summary = { goal: "Запустить курс", stuckAt: "Нет заявок", chosenStep: "Созвон", outcome: "agreed" };
    expect(await run("finish_dialog", summary)).toMatchObject({ ok: true });
    const state = await readPreviewConversation(database.db, chatId);
    expect(state?.summary).toEqual(summary);
    expect(state?.finishedAt).toBeInstanceOf(Date);
  });

  it("finish_dialog отвечает модели, что дальше: при согласии и прощании приложения — ничего своего, кроме ответа на вопрос", async () => {
    const summary = { goal: "Курс", stuckAt: "Нет идеи", chosenStep: "Собрать идею", outcome: "agreed" };
    const withFarewell = createConsultantTools({
      store: createPreviewConversationStore(database.db),
      chatId,
      settings: { ...settings, farewellMessage: "Удачи!" },
      saleDay: async () => 1,
    });
    const result = (await withFarewell.finish_dialog!.execute!(summary as never, callOptions)) as { ok: boolean; next?: string };
    expect(result.ok).toBe(true);
    expect(result.next).toMatch(/answer/);
    expect(result.next).not.toMatch(/пуст/i);
    expect(result.next).not.toMatch(/одна-две фразы/i);

    const plain = (await run("finish_dialog", summary)) as { ok: boolean; next?: string };
    expect(plain.next).toMatch(/последний ответ/i);
    expect(plain.next).not.toMatch(/answer/);
  });

  it("finish_dialog с отказом или уходом: прощание приложения не придёт, консультант прощается сам и ничего не обещает", async () => {
    const withFarewell = createConsultantTools({
      store: createPreviewConversationStore(database.db),
      chatId,
      settings: { ...settings, farewellMessage: "Записал вас на созвон!" },
      saleDay: async () => 1,
    });
    for (const outcome of ["declined", "left"]) {
      const summary = { goal: "Курс", stuckAt: "Нет идеи", chosenStep: "Пока ничего", outcome };
      const result = (await withFarewell.finish_dialog!.execute!(summary as never, callOptions)) as { next?: string };
      expect(result.next).not.toMatch(/answer/);
      expect(result.next).not.toContain("Записал вас на созвон!");
      expect(result.next).toMatch(/попрощайся/i);
      expect(result.next).toMatch(/записал/i);
    }
  });

  it("finish_dialog требует исход: согласился, отказался или ушёл", () => {
    const schema = (tools.finish_dialog as { inputSchema: { safeParse(value: unknown): { success: boolean } } }).inputSchema;
    const summary = { goal: "a", stuckAt: "b", chosenStep: "c" };
    expect(schema.safeParse(summary).success).toBe(false);
    for (const outcome of ["agreed", "declined", "left"]) expect(schema.safeParse({ ...summary, outcome }).success).toBe(true);
    expect(schema.safeParse({ ...summary, outcome: "maybe" }).success).toBe(false);
  });

  it("finish_dialog — после явного согласия с итогом или когда человек сам заканчивает; последний ответ без повтора пересказа", async () => {
    expect(tools.finish_dialog!.description).toMatch(/явного согласия/i);
    expect(tools.finish_dialog!.description).toMatch(/прощается/i);
    expect(tools.finish_dialog!.description).toMatch(/отказался от шага[^\n]*declined/i);
    expect(tools.finish_dialog!.description).toMatch(/«подумаю»[^\n]*«не сейчас»[^\n]*declined[^\n]*left[^\n]*перестал отвечать/i);
    const result = (await run("finish_dialog", { goal: "Курс", stuckAt: "Нет идеи", chosenStep: "Собрать идею", outcome: "agreed" })) as {
      next?: string;
    };
    expect(result.next).toMatch(/не повторяй/i);
  });

  it("finish_dialog: необязательный answer до 200 знаков; описание запрещает выдумывать сроки и порядок связи", () => {
    const schema = (tools.finish_dialog as { inputSchema: { safeParse(value: unknown): { success: boolean } } }).inputSchema;
    const summary = { goal: "a", stuckAt: "b", chosenStep: "c", outcome: "agreed" };
    expect(schema.safeParse(summary).success).toBe(true);
    expect(schema.safeParse({ ...summary, answer: "Созвон бесплатный." }).success).toBe(true);
    expect(schema.safeParse({ ...summary, answer: "а".repeat(201) }).success).toBe(false);
    const json = JSON.stringify(z.toJSONSchema(schema as never));
    expect(json).toMatch(/последней реплике[^"]*задал вопрос/i);
    expect(json).toMatch(/сроки и порядок связи[^"]*не выдумывай[^"]*эксперт свяжется/i);
  });

  it("finish_dialog: описание answer знает прощание и запрещает его пересказывать и благодарить", () => {
    const farewell = "Передам Ольге — она напишет вам здесь. До связи!";
    const withFarewell = createConsultantTools({
      store: createPreviewConversationStore(database.db),
      chatId,
      settings: { ...settings, farewellMessage: farewell },
      saleDay: async () => 1,
    });
    const schema = (withFarewell.finish_dialog as { inputSchema: unknown }).inputSchema;
    const json = JSON.stringify(z.toJSONSchema(schema as never));
    expect(json).toContain(farewell);
    expect(json).toMatch(/только если[^"]*задал вопрос[^"]*только ответ на него/i);
    expect(json).toMatch(/не повторяй, кто, как и когда свяжется[^"]*не благодари/i);
    expect(json).toMatch(/прощание уже отвечает[^"]*не заполняй/i);
  });

  it("finish_dialog: из answer выкинуто то, что повторяет прощание", async () => {
    const withFarewell = createConsultantTools({
      store: createPreviewConversationStore(database.db),
      chatId,
      settings: { ...settings, farewellMessage: "Передам коучу, и он напишет тебе сюда, чтобы договориться о времени." },
      saleDay: async () => 1,
    });
    const summary = { goal: "Курс", stuckAt: "Нет идеи", chosenStep: "Встреча", outcome: "agreed" };
    await withFarewell.finish_dialog!.execute!(
      { ...summary, answer: "Коуч сам напишет тебе сюда, чтобы договориться о времени. Тебе писать никуда не нужно." } as never,
      callOptions,
    );
    expect((await readPreviewConversation(database.db, chatId))?.summary).toEqual({ ...summary, answer: "Тебе писать никуда не нужно." });
  });

  it("finish_dialog требует все три части итога", async () => {
    const schema = (tools.finish_dialog as { inputSchema: { safeParse(value: unknown): { success: boolean } } }).inputSchema;
    expect(schema.safeParse({ goal: "a", stuckAt: "b" }).success).toBe(false);
  });
});

describe("инструменты консультанта в программе", () => {
  let programTools: ToolSet;
  let programSettings: LeadMagnetSettings;
  let day = 1;

  beforeEach(() => {
    const old = {
      ...settings,
      stages: [
        settings.stages[0]!,
        { ...settings.stages[1]!, startDay: 2 },
        { id: "sale", name: "Продажа", instruction: "Предложи курс", transitionCondition: "", startDay: 3, isSale: true },
      ],
      program: { ...newProgramSettings(3), sideTasks: [{ id: "city", task: "Узнать город", fieldId: niche.id, when: "" }] },
    };
    programSettings = { ...old, flow: leadMagnetToFlow(old, [niche, ready]) };
    day = 1;
    programTools = createConsultantTools({ store: createPreviewConversationStore(database.db), chatId, settings: programSettings, saleDay: async () => day });
  });

  const runProgram = (name: string, input: unknown) =>
    programTools[name]!.execute!(input as never, callOptions) as Promise<{ ok: boolean; error?: string }>;

  it("набор: finish_dialog и sale_answer — его пускает только нода «Продажа» (охрана сценария SDK)", () => {
    expect(Object.keys(programTools).sort()).toEqual(["finish_dialog", "sale_answer"]);
    expect(programSettings.flow.states.find((state) => state.id === "sale")!.tools).toContain("sale_answer");
    expect(programSettings.flow.states.find((state) => state.id === "intro")!.tools).not.toContain("sale_answer");
  });

  it("finish_dialog в программе: agreed — только ясное «да» или конкретное действие, «кажется, в деле» — не согласие", () => {
    const description = programTools.finish_dialog!.description!;
    expect(description).toMatch(/agreed[^.]*только[^.]*ясно[^.]*«да»[^.]*действи/i);
    expect(description).toMatch(/«кажется, в деле»[^.]*не согласие/i);
  });

  it("sale_answer: мягкое «нет», потом снова — разобрано; причина и день предложения записаны", async () => {
    day = 3;
    expect(await runProgram("sale_answer", { reason: "price", firm: false })).toMatchObject({ ok: true });
    expect((await readPreviewConversation(database.db, chatId))?.saleAnswer).toMatchObject({ reason: "price", firm: false, softHandled: false, lastOfferDay: 3 });
    await runProgram("sale_answer", { reason: "price", firm: false });
    expect((await readPreviewConversation(database.db, chatId))?.saleAnswer).toMatchObject({ reason: "price", softHandled: true, lastOfferDay: 3 });
  });

  it("sale_answer: на каждое «нет» продукту из «Продажи», и на первое мягкое; отказ от другого — не sale_answer", () => {
    const description = programTools.sale_answer!.description!;
    expect(description).toMatch(/каждое «нет»[^.]*продукту[^.]*«Продаж/i);
    expect(description).toMatch(/перв[^.]*мягк/i);
    expect(description).toMatch(/отказ от другого[^.]*не sale_answer|не вызывай/i);
  });

  it("sale_answer: только причины из списка", () => {
    const schema = (programTools.sale_answer as { inputSchema: { safeParse(value: unknown): { success: boolean } } }).inputSchema;
    expect(schema.safeParse({ reason: "expensive", firm: true }).success).toBe(false);
    for (const reason of ["price", "time", "doubt", "not_interested"]) expect(schema.safeParse({ reason, firm: true }).success).toBe(true);
  });

  it("описания инструментов постоянны у версии (кэш модели)", () => {
    const again = createConsultantTools({ store: createPreviewConversationStore(database.db), chatId: "другой-чат", settings: programSettings, saleDay: async () => 2 });
    for (const name of ["finish_dialog", "sale_answer"]) {
      expect(again[name]!.description).toBe(programTools[name]!.description);
      expect(JSON.stringify(z.toJSONSchema(again[name]!.inputSchema as never))).toBe(JSON.stringify(z.toJSONSchema(programTools[name]!.inputSchema as never)));
    }
  });
});
