// Персонаж: собеседнику уходит только русская реплика до инструмента выхода — без приписок и мыслей модели вслух.
import { describe, expect, it } from "vitest";
import { createAppCatalog, createStubModelCatalog, STUB_MODEL_CHOICE } from "@/modules/platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "@/modules/platform/scripted-model";
import { clientInstructions, CLIENT_WAIT_HOURS_TOOL, CLIENT_WAIT_TOMORROW_TOOL, expertInstructions, incomingForClient } from "./persona-prompts";
import { createPersona, RUSSIAN_ONLY_RETRY } from "./persona";
import type { PersonaModel } from "./persona-model";
import { consultantTurn, said, scenarioRun, silent } from "./test-fixtures";

function modelsAnswering(reply: (call: ScriptedCall) => ScriptedReply): PersonaModel {
  const scripted = createScriptedModel(reply);
  return { catalog: createStubModelCatalog(createAppCatalog({}), scripted.model), choice: STUB_MODEL_CHOICE, env: { STUB_MODEL_API_KEY: "test" } };
}

const personaAnswering = (reply: (call: ScriptedCall) => ScriptedReply) =>
  createPersona({ model: modelsAnswering(reply), instructions: "Ты клиент.", exitTool: "leave_chat", exitDescription: "Уйти" });

describe("createPersona", () => {
  it("после инструмента выхода модель второй раз не зовут: «итог разговора» не пишется вовсе", async () => {
    let calls = 0;
    const persona = await personaAnswering((call) => {
      calls += 1;
      return call.lastToolResult !== undefined ? { text: "Итог по разговору: всё прошло хорошо." } : { text: "Всё, спасибо, пока.", toolCalls: [{ toolName: "leave_chat", input: { reason: "ясно" } }] };
    });
    expect(await persona.reply("Привет")).toEqual({ text: "Всё, спасибо, пока.", finished: true });
    expect(calls).toBe(1);
  });

  it("клиент при выходе сообщает, попрощался ли он; у эксперта такой отметки нет", async () => {
    const leaving = (saidGoodbye: boolean) => (call: ScriptedCall) => call.lastToolResult !== undefined ? { text: "" } : ({ text: "хз если честно", toolCalls: [{ toolName: "leave_chat", input: { reason: "надоело", saidGoodbye } }] });
    const client = (saidGoodbye: boolean) =>
      createPersona({ model: modelsAnswering(leaving(saidGoodbye)), instructions: "Ты клиент.", exitTool: "leave_chat", exitDescription: "Уйти", askGoodbye: true });
    expect(await (await client(false)).reply("Когда удобно?")).toEqual({ text: "хз если честно", finished: true, saidGoodbye: false });
    expect((await (await client(true)).reply("Когда удобно?")).saidGoodbye).toBe(true);
    const expert = await personaAnswering((call) => (call.lastToolResult !== undefined ? { text: "" } : { text: "Всё, готово.", toolCalls: [{ toolName: "leave_chat", input: { reason: "готово" } }] }));
    expect((await expert.reply("Ещё что-то?")).saidGoodbye).toBeUndefined();
  });

  it("в инструкции персонажа есть требование писать только по-русски", async () => {
    let system = "";
    const persona = await personaAnswering((call) => ((system = call.system), { text: "Ладно." }));
    await persona.reply("Привет");
    expect(system).toContain("Ты клиент.");
    expect(system).toMatch(/только по-русски/i);
  });

  it("строки с мыслями модели по-английски не уходят собеседнику", async () => {
    const persona = await personaAnswering(() => ({ text: "Ладно, созвон давай, мой ник @roman_k.\n\nActually I think I want to end it. Hmm, but let's keep going." }));
    expect((await persona.reply("Когда удобно?")).text).toBe("Ладно, созвон давай, мой ник @roman_k.");
  });

  it("английская мысль, приклеенная к русской фразе в одной строке, не уходит собеседнику", async () => {
    const persona = await personaAnswering(() => ({
      text: "Ну хорошо, давайте попробую.\n\nHmm, but she should maybe still be a bit unsure. That's fine.Только я правда не уверена. Но попробовать можно.",
    }));
    expect((await persona.reply("Подходит?")).text).toBe("Ну хорошо, давайте попробую.\n\nТолько я правда не уверена. Но попробовать можно.");
  });

  it("одиночные латинские слова и ссылки в русской реплике остаются", async () => {
    const text = "Занимаюсь в Zoom, вот сайт: https://yoga.example.com/start. Подходит?";
    const persona = await personaAnswering(() => ({ text }));
    expect((await persona.reply("Где занимаетесь?")).text).toBe(text);
  });

  it("клиент программы может промолчать до завтра или несколько часов; текст после инструмента не уходит", async () => {
    const silentClient = (toolName: string, input: Record<string, unknown>) =>
      createPersona({
        model: modelsAnswering((call) => (call.lastToolResult !== undefined ? { text: "(молчу)" } : { text: "Ладно, завтра гляну.", toolCalls: [{ toolName, input }] })),
        instructions: "Ты клиент.",
        exitTool: "leave_chat",
        exitDescription: "Уйти",
        silenceTools: true,
      });
    expect(await (await silentClient(CLIENT_WAIT_TOMORROW_TOOL, { reason: "устал" })).reply("Привет")).toEqual({
      text: "Ладно, завтра гляну.",
      finished: false,
      silence: "tomorrow",
    });
    expect((await (await silentClient(CLIENT_WAIT_HOURS_TOOL, { hours: 3, reason: "занят" })).reply("Привет")).silence).toBe(3);
  });

  it("без программы инструментов молчания у клиента нет", async () => {
    let tools: string[] = [];
    const persona = await personaAnswering((call) => ((tools = call.toolNames), { text: "Ладно." }));
    await persona.reply("Привет");
    expect(tools).toEqual(["leave_chat"]);
  });

  it("ответ целиком не по-русски — персонаж переписывает его один раз", async () => {
    const persona = await personaAnswering((call) => ({ text: call.lastUserText.includes(RUSSIAN_ONLY_RETRY) ? "Ок, давай дальше." : "Let me think about how Roman would answer here." }));
    expect(await persona.reply("Когда удобно?")).toEqual({ text: "Ок, давай дальше.", finished: false, slips: ["ответ целиком не по-русски, переспросили: «Let me think about how Roman would answer here.»"] });
  });
});

describe("expertInstructions", () => {
  it("эксперт знает, что тестового разговора в игре нет, и не выдумывает его", () => {
    const text = expertInstructions(scenarioRun().scenario);
    expect(text).toMatch(/«Проверка»/);
    expect(text).toMatch(/не пиши, что (что-то )?проверил/i);
  });
});

describe("clientInstructions", () => {
  it("клиент вызывает инструмент выхода молча и не пишет ремарок", () => {
    const { scenario } = scenarioRun();
    const text = clientInstructions(scenario, scenario.clients[0]!);
    expect(text).toMatch(/вызывай молча/);
    expect(text).toMatch(/Никаких ремарок/);
    expect(text).toMatch(/Причину пиши только в инструмент/);
    expect(text).toMatch(/saidGoodbye/);
    expect(text).toMatch(/Уходи только после прощания или отказа/);
    expect(text).not.toContain(CLIENT_WAIT_TOMORROW_TOOL);
  });

  it("в программе клиент знает про дни и инструменты молчания", () => {
    const { scenario } = scenarioRun();
    const text = clientInstructions({ ...scenario, days: 3 }, scenario.clients[0]!);
    expect(text).toContain("3 дн");
    expect(text).toContain(CLIENT_WAIT_TOMORROW_TOOL);
    expect(text).toContain(CLIENT_WAIT_HOURS_TOOL);
  });
});

describe("incomingForClient", () => {
  it("без программы — как раньше: сообщения бота подряд или пометка, что бот молчит", () => {
    expect(incomingForClient(consultantTurn({ bot: ["Раз", "Два"] }))).toBe("Раз\n\nДва");
    expect(incomingForClient(consultantTurn({ bot: [] }))).toBe("[Бот ничего не ответил]");
    // Без «Дней и времени» у сообщений есть время, но не день сценария: клиент видит просто текст
    const plain = consultantTurn({ bot: ["Привет"], timeline: [{ at: "2026-10-12T12:00:00Z", localTime: "15:00", localDate: "2026-10-12", kind: "consultant", text: "Привет" }] });
    expect(incomingForClient({ ...plain, sentAt: { at: "2026-10-12T12:00:00Z", localTime: "15:00" } })).toBe("Привет");
  });

  it("в программе — время у каждого сообщения; после молчания — до какого момента молчал и что бот написал", () => {
    expect(incomingForClient(said("Привет", 1, "12:01", [["consultant", 1, "12:01", "Здравствуйте!"]]))).toBe("[день 1, 12:01] Здравствуйте!");
    expect(incomingForClient(said("Ещё", 1, "20:04", []))).toBe("[день 1, 20:04] [Бот ничего не ответил]");
    expect(
      incomingForClient(silent("до завтра", 2, "10:00", [["outreach", 1, "12:16", "Идея"], ["outreach", 2, "10:00", "Доброе утро!"]])),
    ).toBe("[Ты молчал до дня 2, 10:00. За это время бот написал:]\n[день 1, 12:16] Идея\n\n[день 2, 10:00] Доброе утро!");
    expect(incomingForClient(silent("3 ч", 1, "15:00"))).toBe("[Ты молчал до дня 1, 15:00. Бот за это время ничего не написал]");
    // Стенд не кладёт пустую ленту: бот молчал — у хода нет `timeline`, но день сценария есть
    expect(incomingForClient({ ...silent("до завтра", 2, "09:00"), timeline: undefined })).toBe("[Ты молчал до дня 2, 09:00. Бот за это время ничего не написал]");
  });
});
