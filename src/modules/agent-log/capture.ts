import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { ModelCatalog, ProviderDescription } from "@ykurilov/agent-chat-core";
import { wrapLanguageModel, type LanguageModel, type ToolSet } from "ai";
import type { AgentLogSink, LoggedMessage, LoggedPart, LoggedUsage, ModelCallEntry } from "./types";

/** Служебный заголовок: несёт id чата от запроса ядра до перехвата. Провайдеру не уходит. */
const CHAT_HEADER = "x-agent-log-chat";
/** Пауза, после которой вызов в том же чате — уже новый ход. */
const TURN_IDLE_MS = 10 * 60 * 1000;
const MAX_ACTIVE_TURNS = 1000;

interface ActiveTurn {
  turnId: string;
  sink: AgentLogSink;
  /** Длина запроса (без инструкции) у первого вызова хода: повтор того же запроса — тот же ход. */
  firstPromptLength: number;
  /** Длина запроса у прошлого вызова: следующий записывает только то, что добавилось. */
  lastPromptLength: number;
  lastCallAt: number;
}

/** Текущий ход каждого чата. Общий на процесс: инструменты узнают ход по id чата. */
const activeTurns: Map<string, ActiveTurn> = ((globalThis as { __agentLogActiveTurns?: Map<string, ActiveTurn> }).__agentLogActiveTurns ??=
  new Map());

function safely(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error("Журнал агента: запись не удалась", error);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toolOutputValue(output: unknown): unknown {
  if (output && typeof output === "object" && "type" in output && "value" in output) return (output as { value: unknown }).value;
  return output;
}

function logMessage(message: LanguageModelV4Prompt[number]): LoggedMessage {
  if (message.role === "system") return { role: "system", parts: [{ type: "text", text: message.content }] };
  const parts: LoggedPart[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "reasoning":
        parts.push({ type: "reasoning", text: part.text });
        break;
      case "file":
        parts.push({ type: "file", mediaType: part.mediaType });
        break;
      case "tool-call":
        parts.push({ type: "tool-call", id: part.toolCallId, name: part.toolName, input: part.input });
        break;
      case "tool-result":
        parts.push({ type: "tool-result", id: part.toolCallId, name: part.toolName, output: toolOutputValue(part.output) });
        break;
    }
  }
  return { role: message.role, parts };
}

function logUsage(usage: LanguageModelV4Usage | undefined): LoggedUsage | undefined {
  if (!usage) return undefined;
  const result: LoggedUsage = {
    input: usage.inputTokens.total,
    output: usage.outputTokens.total,
    cacheRead: usage.inputTokens.cacheRead,
    cacheWrite: usage.inputTokens.cacheWrite,
    reasoning: usage.outputTokens.reasoning,
  };
  for (const key of Object.keys(result) as Array<keyof LoggedUsage>) if (result[key] === undefined) delete result[key];
  return result;
}

/** Определяет ход вызова и снимает, что из запроса записать: инструкцию и начало — один раз за ход. */
function beginModelCall(chatId: string, sink: AgentLogSink, prompt: LanguageModelV4Prompt): { turnId: string; request: ModelCallEntry["request"] } {
  const instructions = prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const rest = prompt.filter((message) => message.role !== "system");
  const now = Date.now();
  const current = activeTurns.get(chatId);
  // Начало хода — после последнего ответа модели только сообщения человека (вопрос и хвост хода). У шага после
  // инструмента там результат инструмента, а хвост хода (`stepContext`) стоит последним и у него
  const lastReply = rest.findLastIndex((message) => message.role === "assistant");
  const afterReply = rest.slice(lastReply + 1);
  const startsTurn = afterReply.length > 0 && afterReply.every((message) => message.role === "user");
  const isNewTurn =
    !current ||
    current.sink !== sink ||
    now - current.lastCallAt > TURN_IDLE_MS ||
    (startsTurn && rest.length !== current.firstPromptLength);

  if (isNewTurn) {
    const turn: ActiveTurn = { turnId: crypto.randomUUID(), sink, firstPromptLength: rest.length, lastPromptLength: rest.length, lastCallAt: now };
    activeTurns.delete(chatId);
    activeTurns.set(chatId, turn);
    if (activeTurns.size > MAX_ACTIVE_TURNS) activeTurns.delete(activeTurns.keys().next().value!);
    safely(() => sink.startTurn({ id: turn.turnId, chatId, startedAt: new Date(now).toISOString() }));
    // Записываем только последний вопрос: история до него видна в самом чате
    const earlierMessages = lastReply + 1;
    return {
      turnId: turn.turnId,
      request: { instructions, messages: rest.slice(earlierMessages).map(logMessage), earlierMessages },
    };
  }

  const earlierMessages = Math.min(current.lastPromptLength, rest.length);
  current.lastPromptLength = rest.length;
  current.lastCallAt = now;
  return { turnId: current.turnId, request: { messages: rest.slice(earlierMessages).map(logMessage), earlierMessages } };
}

function takeChatId(params: LanguageModelV4CallOptions): { chatId: string | undefined; params: LanguageModelV4CallOptions } {
  const headers = params.headers;
  if (!headers || !(CHAT_HEADER in headers)) return { chatId: undefined, params };
  const { [CHAT_HEADER]: chatId, ...rest } = headers;
  return { chatId: chatId ?? undefined, params: { ...params, headers: rest } };
}

function wrapModel(model: LanguageModel, providerId: string, modelId: string, sink: AgentLogSink): LanguageModel {
  if (typeof model === "string") return model;

  const record = (turnId: string, startedAt: number, request: ModelCallEntry["request"], result: Partial<ModelCallEntry>) =>
    safely(() =>
      sink.addEntry(turnId, {
        kind: "model",
        at: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        providerId,
        modelId,
        request,
        response: result.response ?? { text: "", toolCalls: [] },
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.error ? { error: result.error } : {}),
      }),
    );

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ params: rawParams, model: inner }) => {
        const { chatId, params } = takeChatId(rawParams);
        if (!chatId) return inner.doStream(params);
        const startedAt = Date.now();
        const { turnId, request } = beginModelCall(chatId, sink, params.prompt);

        let result: Awaited<ReturnType<LanguageModelV4["doStream"]>>;
        try {
          result = await inner.doStream(params);
        } catch (error) {
          record(turnId, startedAt, request, { error: errorText(error) });
          throw error;
        }

        const response: ModelCallEntry["response"] = { text: "", toolCalls: [] };
        let reasoning = "";
        let usage: LoggedUsage | undefined;
        let streamError: string | undefined;
        let finished = false;
        const finish = (error?: string) => {
          if (finished) return;
          finished = true;
          if (reasoning) response.reasoning = reasoning;
          record(turnId, startedAt, request, { response, usage, error: error ?? streamError });
        };
        const collect = (part: LanguageModelV4StreamPart) => {
          if (part.type === "text-delta") response.text += part.delta;
          else if (part.type === "reasoning-delta") reasoning += part.delta;
          else if (part.type === "tool-call") response.toolCalls.push({ id: part.toolCallId, name: part.toolName, input: parseJson(part.input) });
          else if (part.type === "finish") {
            usage = logUsage(part.usage);
            response.finishReason = part.finishReason.unified;
          } else if (part.type === "error") streamError = errorText(part.error);
        };

        const reader = result.stream.getReader();
        const stream = new ReadableStream<LanguageModelV4StreamPart>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                finish();
                controller.close();
                return;
              }
              safely(() => collect(value));
              controller.enqueue(value);
            } catch (error) {
              finish(errorText(error));
              controller.error(error);
            }
          },
          cancel(reason) {
            finish("прервано");
            return reader.cancel(reason);
          },
        });
        return { ...result, stream };
      },
      wrapGenerate: async ({ params: rawParams, model: inner }) => {
        const { chatId, params } = takeChatId(rawParams);
        if (!chatId) return inner.doGenerate(params);
        const startedAt = Date.now();
        const { turnId, request } = beginModelCall(chatId, sink, params.prompt);
        try {
          const result = await inner.doGenerate(params);
          const response: ModelCallEntry["response"] = { text: "", toolCalls: [], finishReason: result.finishReason.unified };
          let reasoning = "";
          for (const part of result.content) {
            if (part.type === "text") response.text += part.text;
            else if (part.type === "reasoning") reasoning += part.text;
            else if (part.type === "tool-call") response.toolCalls.push({ id: part.toolCallId, name: part.toolName, input: parseJson(part.input) });
          }
          if (reasoning) response.reasoning = reasoning;
          record(turnId, startedAt, request, { response, usage: logUsage(result.usage) });
          return result;
        } catch (error) {
          record(turnId, startedAt, request, { error: errorText(error) });
          throw error;
        }
      },
    },
  });
}

/** Тот же провайдер, но каждый вызов модели записывается в журнал хода. */
function logProvider(provider: ProviderDescription, sink: AgentLogSink): ProviderDescription {
  const overrides: Partial<ProviderDescription> = {
    createLanguageModel: (providerModelId, apiKey, options) =>
      wrapModel(provider.createLanguageModel(providerModelId, apiKey, options), provider.id, providerModelId, sink),
    requestOptions: (context) => {
      const options = provider.requestOptions(context);
      return { ...options, headers: { ...options.headers, [CHAT_HEADER]: context.chatId } };
    },
  };
  if (provider.connect) overrides.connect = (connection) => logProvider(provider.connect!(connection), sink);
  // Прототип сохраняется: методы провайдера-класса остаются на месте
  return Object.assign(Object.create(Object.getPrototypeOf(provider) as object) as ProviderDescription, provider, overrides);
}

/**
 * Каталог, чьи модели пишут в журнал каждый вызов: что ушло, что пришло, токены, время. Запрос к модели не меняется,
 * так что кэш модели не страдает. Сбой журнала уходит в консоль, ход идёт дальше.
 */
export function withAgentLog(catalog: ModelCatalog, sink: AgentLogSink): ModelCatalog {
  return { ...catalog, providers: catalog.providers.map((provider) => logProvider(provider, sink)) };
}

/** Те же инструменты, но каждый вызов (аргументы, результат или ошибка, время) пишется в текущий ход чата. */
export function logToolCalls<T extends ToolSet>(tools: T, chatId: string): T {
  const logged: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute;
    if (!execute) {
      logged[name] = definition;
      continue;
    }
    logged[name] = {
      ...definition,
      execute: async (input: unknown, options: { toolCallId?: string }) => {
        const turn = activeTurns.get(chatId);
        const startedAt = Date.now();
        const write = (result: { output?: unknown; error?: string }) => {
          if (!turn) return;
          safely(() =>
            turn.sink.addEntry(turn.turnId, {
              kind: "tool",
              at: new Date(startedAt).toISOString(),
              durationMs: Date.now() - startedAt,
              toolCallId: options?.toolCallId,
              name,
              input,
              ...result,
            }),
          );
        };
        try {
          const output: unknown = await (execute as (input: unknown, options: unknown) => unknown)(input, options);
          write({ output });
          return output;
        } catch (error) {
          write({ error: errorText(error) });
          throw error;
        }
      },
    };
  }
  return logged as T;
}
