import { createChatService, createInMemoryChatStorage, type ChatService } from "@ykurilov/agent-chat-core";
import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { STUB_MODEL_CHOICE, createAppCatalog, createStubModelCatalog } from "../platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "../platform/scripted-model";
import { logToolCalls, withAgentLog } from "./capture";
import type { AgentLogEntry, AgentLogSink } from "./types";

const INSTRUCTIONS = "Ты помощник. Отвечай коротко.";

function memorySink() {
  const turns: Array<{ id: string; chatId: string }> = [];
  const entries: Array<{ turnId: string; entry: AgentLogEntry }> = [];
  const sink: AgentLogSink = {
    startTurn: (turn) => void turns.push({ id: turn.id, chatId: turn.chatId }),
    addEntry: (turnId, entry) => void entries.push({ turnId, entry }),
  };
  return { sink, turns, entries };
}

function setup(reply: (call: ScriptedCall) => ScriptedReply, execute: (input: { value: string }) => Promise<string>) {
  const scripted = createScriptedModel(reply);
  const log = memorySink();
  const chat = createChatService({
    storage: createInMemoryChatStorage(),
    catalog: withAgentLog(createStubModelCatalog(createAppCatalog({}), scripted.model), log.sink),
    defaultChoice: STUB_MODEL_CHOICE,
    env: { STUB_MODEL_API_KEY: "test" },
    agent: {
      instructions: INSTRUCTIONS,
      tools: (model) =>
        logToolCalls(
          { remember: tool({ description: "Запомнить", inputSchema: z.object({ value: z.string() }), execute }) },
          model.chatId,
        ),
    },
  });
  return { chat, scripted, log };
}

async function say(chat: ChatService, chatId: string, id: string, text: string) {
  const stream = await chat.sendMessage("owner", chatId, { id, role: "user", parts: [{ type: "text", text }] });
  await stream.pipeTo(new WritableStream());
}

const toolThenText = (call: ScriptedCall): ScriptedReply =>
  call.lastToolResult !== undefined ? { text: "Запомнил." } : { toolCalls: [{ toolName: "remember", input: { value: "кот" } }] };

describe("журнал работы агента", () => {
  it("ход: два вызова модели и вызов инструмента под одним ходом; модель не видит служебный заголовок", async () => {
    const { chat, scripted, log } = setup(toolThenText, async ({ value }) => `ок: ${value}`);
    const { id: chatId } = await chat.createChat("owner");
    await say(chat, chatId, "m1", "Запомни: кот");

    expect(log.turns).toEqual([{ id: expect.any(String), chatId }]);
    const turnId = log.turns[0]!.id;
    expect(log.entries.every((item) => item.turnId === turnId)).toBe(true);
    const kinds = log.entries.map((item) => item.entry.kind);
    expect(kinds).toEqual(["model", "tool", "model"]);

    const [first, toolCall, second] = log.entries.map((item) => item.entry);
    if (first?.kind !== "model" || toolCall?.kind !== "tool" || second?.kind !== "model") throw new Error("порядок");
    expect(first.modelId).toBe("stub-v1");
    expect(first.request.instructions).toBe(INSTRUCTIONS);
    expect(JSON.stringify(first.request.messages)).toContain("Запомни: кот");
    expect(first.response.toolCalls).toEqual([{ id: expect.any(String), name: "remember", input: { value: "кот" } }]);
    expect(first.usage).toMatchObject({ input: 10, output: 5 });
    expect(first.durationMs).toBeGreaterThanOrEqual(0);

    expect(toolCall).toMatchObject({ name: "remember", input: { value: "кот" }, output: "ок: кот" });
    expect(toolCall.durationMs).toBeGreaterThanOrEqual(0);

    // Второй вызов: инструкция и начало не повторяются, только новое — вызов и результат инструмента
    expect(second.request.instructions).toBeUndefined();
    expect(second.request.earlierMessages).toBeGreaterThan(0);
    expect(JSON.stringify(second.request.messages)).toContain("ок: кот");
    expect(JSON.stringify(second.request.messages)).not.toContain("Запомни: кот");
    expect(second.response.text).toBe("Запомнил.");

    for (const call of scripted.calls) expect(JSON.stringify(call.options.headers ?? {})).not.toMatch(/agent-log/i);
  });

  it("хвост хода в конце каждого шага (stepContext): ход с инструментом — всё равно один ход", async () => {
    const scripted = createScriptedModel(toolThenText);
    const log = memorySink();
    const chat = createChatService({
      storage: createInMemoryChatStorage(),
      catalog: withAgentLog(createStubModelCatalog(createAppCatalog({}), scripted.model), log.sink),
      defaultChoice: STUB_MODEL_CHOICE,
      env: { STUB_MODEL_API_KEY: "test" },
      agent: {
        instructions: INSTRUCTIONS,
        stepContext: () => "Осталось 5 сообщений.",
        tools: (model) =>
          logToolCalls(
            { remember: tool({ description: "Запомнить", inputSchema: z.object({ value: z.string() }), execute: async () => "ок" }) },
            model.chatId,
          ),
      },
    });
    const { id: chatId } = await chat.createChat("owner");
    await say(chat, chatId, "m1", "Запомни: кот");

    expect(scripted.calls).toHaveLength(2);
    expect(log.turns).toHaveLength(1);
    expect(log.entries.map((item) => item.entry.kind)).toEqual(["model", "tool", "model"]);
    const [first, , second] = log.entries.map((item) => item.entry);
    if (first?.kind !== "model" || second?.kind !== "model") throw new Error("порядок");
    expect(JSON.stringify(first.request.messages)).toContain("Осталось 5 сообщений.");
    expect(JSON.stringify(second.request.messages)).toContain("ок");
  });

  it("следующее сообщение человека — новый ход", async () => {
    const { chat, log } = setup(() => ({ text: "Привет." }), async () => "");
    const { id: chatId } = await chat.createChat("owner");
    await say(chat, chatId, "m1", "Привет");
    await say(chat, chatId, "m2", "Как дела?");
    expect(log.turns).toHaveLength(2);
    const second = log.entries.filter((item) => item.turnId === log.turns[1]!.id).map((item) => item.entry);
    expect(second).toHaveLength(1);
    if (second[0]?.kind !== "model") throw new Error("ожидался вызов модели");
    expect(JSON.stringify(second[0].request.messages)).toContain("Как дела?");
    expect(JSON.stringify(second[0].request.messages)).not.toContain("Привет\"");
    expect(second[0].request.earlierMessages).toBe(2);
  });

  it("ошибка инструмента записана, ход идёт дальше", async () => {
    const { chat, log } = setup(toolThenText, async () => {
      throw new Error("база недоступна");
    });
    const { id: chatId } = await chat.createChat("owner");
    await say(chat, chatId, "m1", "Запомни: кот");
    const toolCall = log.entries.map((item) => item.entry).find((entry) => entry.kind === "tool");
    expect(toolCall).toMatchObject({ name: "remember", error: "база недоступна" });
    expect(log.entries.map((item) => item.entry.kind)).toEqual(["model", "tool", "model"]);
  });

  it("сбой журнала не ломает ход", async () => {
    const scripted = createScriptedModel(toolThenText);
    const broken: AgentLogSink = {
      startTurn: () => {
        throw new Error("журнал сломан");
      },
      addEntry: () => {
        throw new Error("журнал сломан");
      },
    };
    const chat = createChatService({
      storage: createInMemoryChatStorage(),
      catalog: withAgentLog(createStubModelCatalog(createAppCatalog({}), scripted.model), broken),
      defaultChoice: STUB_MODEL_CHOICE,
      env: { STUB_MODEL_API_KEY: "test" },
      agent: {
        instructions: INSTRUCTIONS,
        tools: (model) =>
          logToolCalls(
            { remember: tool({ description: "Запомнить", inputSchema: z.object({ value: z.string() }), execute: async () => "ок" }) },
            model.chatId,
          ),
      },
    });
    const { id: chatId } = await chat.createChat("owner");
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      await say(chat, chatId, "m1", "Запомни");
    } finally {
      console.error = original;
    }
    expect(scripted.calls).toHaveLength(2);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("ошибка модели записана в журнал хода", async () => {
    const scripted = createScriptedModel(() => {
      throw new Error("провайдер упал");
    });
    const log = memorySink();
    const chat = createChatService({
      storage: createInMemoryChatStorage(),
      catalog: withAgentLog(createStubModelCatalog(createAppCatalog({}), scripted.model), log.sink),
      defaultChoice: STUB_MODEL_CHOICE,
      env: { STUB_MODEL_API_KEY: "test" },
      agent: { instructions: INSTRUCTIONS },
    });
    const { id: chatId } = await chat.createChat("owner");
    await say(chat, chatId, "m1", "Привет");
    const model = log.entries.map((item) => item.entry).find((entry) => entry.kind === "model");
    expect(model?.kind === "model" && model.error).toContain("провайдер упал");
  });
});
