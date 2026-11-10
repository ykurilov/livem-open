import { answerText, type StoredMessage } from "@ykurilov/agent-chat-core";
import type { CorrectionContextLine } from "./types";

/** Столько же реплик видит судья переходов. */
export const CORRECTION_CONTEXT_MESSAGES = 6;
export const CORRECTION_CONTEXT_CHARS = 4000;

type MessagePart = StoredMessage["parts"][number];

/** Сообщение ветки чата; `stage` — название ноды, где оно прозвучало (его знает тот, кто зовёт). */
export interface CorrectionBranchMessage {
  id: string;
  role: StoredMessage["role"];
  parts: StoredMessage["parts"];
  stage?: string;
}

/**
 * Копия куска разговора перед ответом: до 6 реплик с текстом, вместе не больше 4000 знаков. Не влезает — уходят
 * старые реплики; одна последняя длиннее предела — остаётся её конец.
 */
export function correctionContext(branch: readonly CorrectionBranchMessage[], answerId: string): CorrectionContextLine[] {
  const answerIndex = branch.findIndex((message) => message.id === answerId);
  if (answerIndex < 0) return [];
  const lines = branch
    .slice(0, answerIndex)
    .map((message): CorrectionContextLine => ({ role: message.role, text: answerText(message.parts).trim(), ...(message.stage ? { stage: message.stage } : {}) }))
    .filter((line) => line.text.length > 0)
    .slice(-CORRECTION_CONTEXT_MESSAGES);

  const kept: CorrectionContextLine[] = [];
  let room = CORRECTION_CONTEXT_CHARS;
  for (const line of lines.reverse()) {
    if (line.text.length <= room) {
      kept.unshift(line);
      room -= line.text.length;
    } else {
      if (kept.length === 0) kept.unshift({ ...line, text: `…${line.text.slice(line.text.length - room + 1)}` });
      break;
    }
  }
  return kept;
}

type ToolPart = { type: string; toolName?: string; state?: string; input?: unknown; output?: unknown };

const field = (value: unknown, key: string): unknown => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined);
const title = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Что консультант сделал в ответе, кроме текста: понятными словами, по порядку. Неудачные вызовы не в счёт. */
export function answerActions(parts: readonly MessagePart[]): string[] {
  const actions: string[] = [];
  for (const raw of parts) {
    const part = raw as ToolPart;
    const name = part.type === "dynamic-tool" ? part.toolName : part.type.startsWith("tool-") ? part.type.slice("tool-".length) : undefined;
    if (!name || part.state !== "output-available") continue;
    const action = actionOf(name, part.input, withoutFlowWrapper(part.output));
    if (action) actions.push(action);
  }
  return actions;
}

/** Инструмент, после которого сценарий сменил ноду, отдаёт `{ result, flow }`: действие — по `result`. */
function withoutFlowWrapper(output: unknown): unknown {
  return output && typeof output === "object" && "result" in output && "flow" in output ? (output as { result: unknown }).result : output;
}

function actionOf(name: string, input: unknown, output: unknown): string | null {
  switch (name) {
    case "flow_note": {
      if (typeof output !== "string" || !output.startsWith("Записано")) return null;
      if (field(input, "fact") !== undefined) return "записал факт о человеке";
      const fieldName = /«([^»]+)»/.exec(output)?.[1] ?? title(field(input, "field"));
      return fieldName ? `сохранил поле «${fieldName}»` : "сохранил поле";
    }
    case "show_video": {
      const video = field(output, "видео");
      if (!video) return null;
      const videoTitle = title(field(video, "название"));
      return videoTitle ? `прислал ролик «${videoTitle}»` : "прислал ролик";
    }
    case "show_image": {
      const image = field(output, "картинка");
      if (!image) return null;
      const imageTitle = title(field(image, "название"));
      return imageTitle ? `прислал картинку «${imageTitle}»` : "прислал картинку";
    }
    case "finish_dialog":
      return field(output, "ok") === true ? "завершил разговор" : null;
    default:
      return null;
  }
}
