import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";

/** Что подставная модель отвечает на один запрос: текст и/или вызовы инструментов. */
export interface ScriptedReply {
  text?: string;
  /** `inputText` — аргументы как есть, даже кривой JSON; иначе `input` в JSON. */
  toolCalls?: Array<{ toolName: string; input?: unknown; inputText?: string }>;
  /** Задержка перед ответом, мс: в сквозной проверке виден «идёт ход». */
  delayMs?: number;
  /** Ответ уходит, только когда обещание выполнится: тест держит ход «идущим», сколько нужно. */
  until?: Promise<unknown>;
}

/** Запрос к подставной модели в удобном для сценария виде. */
export interface ScriptedCall {
  options: LanguageModelV4CallOptions;
  /** Системная инструкция целиком. */
  system: string;
  /** Текст последнего сообщения человека вместе с хвостом хода (`stepContext`). */
  lastUserText: string;
  /** Инструменты, которые видит модель. */
  toolNames: string[];
  /** Последний результат инструмента в запросе — модель уже вызывала инструмент в этом ходе. */
  lastToolResult: unknown;
}

function textOfUserMessage(message: LanguageModelV4CallOptions["prompt"][number] | undefined): string {
  if (!message || message.role !== "user") return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/**
 * Хвост хода (`stepContext`) приходит отдельным сообщением человека в самом конце запроса — и после результата
 * инструмента. Поэтому «последнее» сообщение смотрится до хвостовых сообщений человека, а хвост добавляется к вопросу.
 */
function describeCall(options: LanguageModelV4CallOptions): ScriptedCall {
  const system = options.prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const prompt = options.prompt.filter((message) => message.role !== "system");
  let trailingFrom = prompt.length;
  while (trailingFrom > 0 && prompt[trailingFrom - 1]!.role === "user") trailingFrom--;
  const trailing = prompt.slice(trailingFrom);
  const beforeTrailing = prompt[trailingFrom - 1];
  let lastToolResult: unknown;
  if (beforeTrailing?.role === "tool") {
    const result = beforeTrailing.content.at(-1);
    if (result?.type === "tool-result") lastToolResult = result.output;
  }
  // Шаг после инструмента: вопрос человека — до вызова, в конце только хвост
  const question = beforeTrailing?.role === "tool" ? prompt.slice(0, trailingFrom).findLast((message) => message.role === "user") : undefined;
  return {
    options,
    system,
    lastUserText: [question, ...trailing].map(textOfUserMessage).filter(Boolean).join("\n"),
    toolNames: (options.tools ?? []).map((tool) => tool.name),
    lastToolResult,
  };
}

let callCounter = 0;

function streamOf(reply: ScriptedReply): ReadableStream<LanguageModelV4StreamPart> {
  const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if (reply.text) {
    const id = `text-${++callCounter}`;
    parts.push({ type: "text-start", id }, { type: "text-delta", id, delta: reply.text }, { type: "text-end", id });
  }
  for (const call of reply.toolCalls ?? []) {
    parts.push({
      type: "tool-call",
      toolCallId: `call-${++callCounter}`,
      toolName: call.toolName,
      input: call.inputText ?? JSON.stringify(call.input),
    });
  }
  parts.push({
    type: "finish",
    finishReason: reply.toolCalls?.length ? { unified: "tool-calls", raw: "tool_calls" } : { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
  });
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/**
 * Подставная модель по сценарию: на каждый запрос зовёт `reply` и отвечает его результатом.
 * Для тестов и сквозной проверки без настоящей модели. Все запросы копятся в `calls`.
 */
export function createScriptedModel(reply: (call: ScriptedCall) => ScriptedReply) {
  const calls: ScriptedCall[] = [];
  async function answerTo(options: LanguageModelV4CallOptions): Promise<ScriptedReply> {
    const call = describeCall(options);
    calls.push(call);
    const answer = reply(call);
    if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    if (answer.until) await answer.until;
    return answer;
  }
  const model = new MockLanguageModelV4({
    doStream: async (options) => ({ stream: streamOf(await answerTo(options)) }),
    // Короткие служебные запросы без потока: переписать ответ, текст напоминания
    doGenerate: async (options) => {
      const answer = await answerTo(options);
      return {
        content: answer.text ? [{ type: "text", text: answer.text }] : [],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model, calls };
}
