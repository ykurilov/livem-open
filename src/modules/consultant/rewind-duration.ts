import { parseDuration } from "@ykurilov/agent-chat-flows/format";

/** Перемотка часов тестового чата за один раз: от минуты до года — чтобы проверить, как агент встречает вернувшегося. */
export const MIN_REWIND_MS = 60_000;
const DAY_MS = 86_400_000;
export const MAX_REWIND_MS = 365 * DAY_MS;

export type RewindDuration = { ok: true; ms: number } | { ok: false; hint: string };

const EXAMPLES = "Напишите время, например: 45 мин, 1 ч 30 мин, 2 дня, 2 недели, 3 месяца";
const OUT_OF_RANGE = "Промотать можно от минуты до года";

/** Недели, месяцы и годы SDK не разбирает: в сутки, месяц — 30 суток, год — 365. */
const LONG_UNITS: ReadonlyArray<{ pattern: RegExp; days: number }> = [
  { pattern: /^нед(?:ел[ьяиюе]|ели|елей)?$/, days: 7 },
  { pattern: /^мес(?:яц|яца|яцев)?$/, days: 30 },
  { pattern: /^(?:год|года|лет)$/, days: 365 },
];
const LONG_PART = /(\d+(?:[.,]\d+)?)\s*([а-яё]+)/giu;

/** «Неделя», «2 месяца», «1 год» — в сутки, остальное без изменений: дальше разбирает SDK. */
function longUnitsToDays(text: string): string {
  return text.replace(LONG_PART, (part, amount: string, unit: string) => {
    const long = LONG_UNITS.find(({ pattern }) => pattern.test(unit.toLowerCase()));
    return long ? ` ${Number(amount.replace(",", ".")) * long.days} д ` : part;
  });
}

/** «45 мин», «1 ч 30 мин», «2 дня», «3 недели», «2 месяца» — в миллисекунды; не разобралось или за пределами — подсказка словами. */
export function parseRewindDuration(text: string): RewindDuration {
  const parsed = parseDuration(longUnitsToDays(text));
  if (parsed === undefined) return { ok: false, hint: EXAMPLES };
  const ms = Math.round(parsed);
  if (ms < MIN_REWIND_MS || ms > MAX_REWIND_MS) return { ok: false, hint: OUT_OF_RANGE };
  return { ok: true, ms };
}
