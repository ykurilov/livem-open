/**
 * Что эксперт велел сделать с правкой ответа («Что сделать с правкой» в окне «Поправить»): `auto` — решает конструктор,
 * `principles` — поправить правила, чтобы консультант сам отвечал в таком духе, `formula` — обобщить ответ в формулу-
 * заготовку, `card` — эксперт сам сохраняет ответ заготовкой.
 */
export const CORRECTION_INTENTS = ["auto", "principles", "formula", "card"] as const;
export type CorrectionIntent = (typeof CORRECTION_INTENTS)[number];

/** Выбор из полей окна правки; нет или чужой — `undefined`: у новой правки решает конструктор, у повторной — прежний выбор. */
export function correctionIntentOf(data: Record<string, unknown> | undefined): CorrectionIntent | undefined {
  const intent = data?.intent;
  return typeof intent === "string" && (CORRECTION_INTENTS as readonly string[]).includes(intent) ? (intent as CorrectionIntent) : undefined;
}

/**
 * Что показать в окне «Поправить»: выбор эксперта, а не тронут — тот, что запишется. У ответа с неразобранной правкой
 * сервер оставляет её прежний выбор (`pendingIntent`), у новой правки — `auto`.
 */
export function shownCorrectionIntent(data: Record<string, unknown> | undefined, pendingIntent: CorrectionIntent | undefined): CorrectionIntent {
  return correctionIntentOf(data) ?? pendingIntent ?? "auto";
}
