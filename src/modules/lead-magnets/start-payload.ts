/** Общий предел стартового параметра: Telegram допускает 64 base64url-символа, MAX — 128. */
export const START_PAYLOAD_LIMIT = 64;
export const ENTRY_LABEL_LIMIT = 41;
export const ENTRY_LABEL_SEPARATOR = "__ad_campaign__";

export interface LabeledStartPayload {
  code: string;
  /** Невалидная метка не мешает открыть основной лидмагнит. */
  label: string | null;
}

/**
 * Только основной код из 8 букв/цифр + `__ad_campaign__` + ASCII-метка. Не декодируем URL повторно, не обрезаем пробелы.
 * Даже для огромного входа читаем лишь фиксированный префикс; регулярное выражение метки ограничено 64 знаками.
 * Точные сохранённые коды разрешаются отдельно и имеют приоритет.
 */
export function parseLabeledStartPayload(payload: string): LabeledStartPayload | null {
  const prefix = payload.slice(0, 23);
  if (!/^[A-Za-z0-9]{8}__ad_campaign__$/.test(prefix)) return null;
  const code = prefix.slice(0, 8);
  if (payload.length > START_PAYLOAD_LIMIT) return { code, label: null };
  const label = payload.slice(23);
  return { code, label: label.length >= 1 && label.length <= ENTRY_LABEL_LIMIT && !/[^A-Za-z0-9_-]/.test(label) ? label.toLowerCase() : null };
}
