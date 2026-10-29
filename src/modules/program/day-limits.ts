import type { ProgramSettings } from "../lead-magnets/settings";

/**
 * Рамка сегодняшнего разговора:
 * `normal` — обычный разговор, `soft` — консультант по-доброму прощается до завтра,
 * `last` — последнее сообщение дня, «продолжим утром», `closed` — консультант до утра не вызывается.
 */
/** Заготовка на первое сообщение после жёсткой рамки дня: модель не вызывается. */
export const DAY_CLOSED_TEXT = "Утром отвечу!";

export type DayLimitState = "normal" | "soft" | "last" | "closed";

/** `messagesToday` — сообщения человека за день программы, включая то, на которое сейчас отвечают. */
export function dayLimitState(
  messagesToday: number,
  limits: Pick<ProgramSettings, "softDailyMessages" | "hardDailyMessages">,
): DayLimitState {
  if (messagesToday > limits.hardDailyMessages) return "closed";
  if (messagesToday === limits.hardDailyMessages) return "last";
  if (messagesToday >= limits.softDailyMessages) return "soft";
  return "normal";
}
