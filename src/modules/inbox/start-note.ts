import { parseLabeledStartPayload } from "../lead-magnets/start-payload";

/** Сообщение человека — служебный старт бота (`/start` с кодом ссылки или без), а не его слова. */
export function isStartMessage(message: { text: string; startCode: string | null }): boolean {
  return message.startCode !== null || /^\/start(\s|$)/.test(message.text.trim());
}

/**
 * Как старт бота выглядит в переписке: по какой ссылке пришёл человек, без кода ссылки.
 * `labels` — метки ссылок по их коду; у основной ссылки метки нет (`null`).
 */
export function startNote(startCode: string | null, labels: ReadonlyMap<string, string | null>): string {
  if (startCode === null) return "Запуск бота";
  const label = labels.get(startCode);
  if (label) return `Запуск бота по ссылке «${label}»`;
  const advertised = labels.has(startCode) ? null : parseLabeledStartPayload(startCode);
  if (advertised?.label) return `Запуск бота по рекламной ссылке «${advertised.label}»`;
  return "Запуск бота по ссылке";
}
