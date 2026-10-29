// Разбор сообщений SDK: текст ответа, вызовы инструментов, текст после finish_dialog.
import type { StoredMessage } from "@ykurilov/agent-chat-core";
import { isOutreachRequest } from "@/modules/consultant/outreach-request";
import type { StoredChatMessage, ToolCallRecord } from "./types";

interface ToolPart {
  type: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  errorText?: string;
}

type Part = { type: string; text?: string } & ToolPart;

function toolNameOf(part: Part): string | null {
  if (part.type === "dynamic-tool") return part.toolName ?? "dynamic-tool";
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : null;
}

export function toolCallsOf(messages: Array<Pick<StoredMessage, "parts">>): ToolCallRecord[] {
  return messages.flatMap((message) =>
    (message.parts as Part[]).flatMap((part) => {
      const name = toolNameOf(part);
      if (!name) return [];
      return [
        {
          name,
          input: part.input,
          ...(part.output !== undefined && { output: part.output }),
          ...(part.state === "output-error" && { error: part.errorText ?? "ошибка инструмента" }),
        },
      ];
    }),
  );
}

export function textOf(messages: Array<Pick<StoredMessage, "parts">>): string {
  return messages
    .flatMap((message) => (message.parts as Part[]).filter((part) => part.type === "text").map((part) => part.text ?? ""))
    .join("\n")
    .trim();
}

/** Текст после вызова инструмента `toolName`; `null` — вызова не было или после него нет текста. */
export function textAfterTool(messages: Array<Pick<StoredMessage, "parts">>, toolName: string): string | null {
  const parts = messages.flatMap((message) => message.parts as Part[]);
  const index = parts.findIndex((part) => toolNameOf(part) === toolName);
  if (index < 0) return null;
  const text = parts
    .slice(index + 1)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  return text || null;
}

/** Транскрипт разговора: служебная просьба «напиши первым» — не слова клиента, в транскрипт не идёт. */
export function storedChat(messages: StoredMessage[]): StoredChatMessage[] {
  return messages
    .filter((message) => !isOutreachRequest(message))
    .map((message) => ({ role: message.role, status: message.status, parts: message.parts }));
}
