import { answerText, type StoredMessage } from "@ykurilov/agent-chat-core";
import { correctionContext, type CorrectionContextLine } from "../corrections";
import type { RoleSwapAnswerMark } from "./schema";

/** Ответ эксперта на разбор: что он написал, что было перед этим и где это было. */
export interface RoleSwapReviewItem {
  messageId: string;
  expertText: string;
  /** Весь разговор до ответа глазами консультанта (`user` — клиент): по нему считается пробный ход. */
  history: Array<{ role: "user" | "assistant"; text: string }>;
  /** Кусок разговора перед ответом для записи на разбор: до 6 реплик, не длиннее 4000 знаков. */
  context: CorrectionContextLine[];
  stageId: string | null;
  draftVersionId: string;
}

/** В чате режима эксперт — человек модуля, клиент — агент; консультант видит наоборот. */
function asConsultantSees(message: StoredMessage): StoredMessage {
  return { ...message, role: message.role === "user" ? "assistant" : "user" };
}

/**
 * Ответы эксперта текущей ветки, кроме первого сообщения лидмагнита. Брошенные ветки сюда не попадают: берётся только
 * переданная ветка. Версия и нода — из отметки ответа; отметки нет — версия на момент отдачи, без ноды.
 */
export function roleSwapReviewItems(
  branch: readonly StoredMessage[],
  marks: Readonly<Record<string, RoleSwapAnswerMark>>,
  currentDraftVersionId: string,
): RoleSwapReviewItem[] {
  const seen = branch.map(asConsultantSees);
  const lines = seen.map((message) => ({ role: message.role, text: answerText(message.parts).trim() }));
  const items: RoleSwapReviewItem[] = [];
  for (const [index, message] of branch.entries()) {
    if (index === 0 || message.role !== "user") continue;
    const expertText = lines[index]!.text;
    if (!expertText) continue;
    const mark = marks[message.id];
    items.push({
      messageId: message.id,
      expertText,
      history: lines
        .slice(0, index)
        .filter((line): line is { role: "user" | "assistant"; text: string } => line.text.length > 0 && (line.role === "user" || line.role === "assistant")),
      context: correctionContext(seen, message.id),
      stageId: mark?.stageId ?? null,
      draftVersionId: mark?.draftVersionId ?? currentDraftVersionId,
    });
  }
  return items;
}
