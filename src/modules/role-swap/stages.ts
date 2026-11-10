import { answerText, type StoredMessage } from "@ykurilov/agent-chat-core";
import type { JudgeExchangeInput } from "@ykurilov/agent-chat-flows";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";

/** Сколько последних реплик видит судья: столько же, сколько в обычном ходе. */
export const JUDGE_TRANSCRIPT_LINES = 6;

/**
 * Нода разговора перед репликой `index` текущей ветки: последняя проверенная нода после реплики клиента выше по ветке.
 * Проверки ещё не было или нода пропала из черновика — стартовая. Правка своей реплики даёт новую ветку, и нода берётся
 * с места правки: брошенная ветка сюда не попадает.
 */
export function stageBefore(branch: readonly StoredMessage[], clientStages: Readonly<Record<string, string>>, index: number, flow: AgentFlow): string | null {
  let stageId = flow.start;
  for (const message of branch.slice(0, index)) {
    const checked = message.role === "assistant" ? clientStages[message.id] : undefined;
    if (checked) stageId = checked;
  }
  return stageId && flow.states.some((state) => state.id === stageId) ? stageId : flow.start;
}

/**
 * Переписка для судьи до реплики `index` включительно глазами консультанта: эксперт — `agent`, клиент — `person`.
 * Только последние реплики с текстом.
 */
export function judgeTranscript(branch: readonly StoredMessage[], index: number): JudgeExchangeInput["transcript"] {
  return branch
    .slice(0, index + 1)
    .flatMap((message) => {
      const text = answerText(message.parts).trim();
      if (!text || (message.role !== "user" && message.role !== "assistant")) return [];
      return [{ role: message.role === "user" ? ("agent" as const) : ("person" as const), text }];
    })
    .slice(-JUDGE_TRANSCRIPT_LINES);
}

/** Название ноды для строки над лентой. */
export const stageTitle = (flow: AgentFlow, stageId: string | null): string | null =>
  flow.states.find((state) => state.id === stageId)?.title ?? null;
