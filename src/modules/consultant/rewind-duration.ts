import { parseDuration } from "@ykurilov/agent-chat-flows/format";

/** Перемотка часов тестового чата за один раз: от минуты до тридцати суток. */
export const MIN_REWIND_MS = 60_000;
export const MAX_REWIND_MS = 30 * 86_400_000;

export type RewindDuration = { ok: true; ms: number } | { ok: false; hint: string };

const EXAMPLES = "Напишите время, например: 45 мин, 1 ч 30 мин, 2 дня";
const OUT_OF_RANGE = "Промотать можно от минуты до 30 суток";

/** «45 мин», «1 ч 30 мин», «2 дня» — в миллисекунды (разбор — SDK); не разобралось или за пределами — подсказка словами. */
export function parseRewindDuration(text: string): RewindDuration {
  const parsed = parseDuration(text);
  if (parsed === undefined) return { ok: false, hint: EXAMPLES };
  const ms = Math.round(parsed);
  if (ms < MIN_REWIND_MS || ms > MAX_REWIND_MS) return { ok: false, hint: OUT_OF_RANGE };
  return { ok: true, ms };
}
