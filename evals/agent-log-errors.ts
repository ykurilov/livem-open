// Ошибки журнала агентов для проверки «Нет ошибок»: что упало на самом деле, а что закрыл запасной путь провайдеров.

/** Запись журнала в том виде, в каком её читает eval: ход и данные вызова. */
export interface JournalEntry {
  turnId: string;
  data: { kind: string; name?: string; modelId?: string; providerId?: string; error?: string };
}

/**
 * Сбой модели, после которого в том же ходе модель ответила (повтор или запасной провайдер `providerFallback`), — закрыт:
 * ход дошёл до человека. Ошибка — сбой модели без удачного вызова после него и любой упавший инструмент.
 */
export function splitAgentLogErrors(entries: JournalEntry[]): { errors: string[]; recovered: string[] } {
  const errors: string[] = [];
  const recovered: string[] = [];
  entries.forEach(({ turnId, data }, index) => {
    if (!data.error) return;
    if (data.kind === "tool") {
      errors.push(`инструмент ${data.name}: ${data.error}`);
      return;
    }
    const answered = entries.slice(index + 1).find((later) => later.turnId === turnId && later.data.kind === "model" && !later.data.error);
    const route = answered ? `${data.providerId} → ${answered.data.providerId}` : data.providerId;
    const line = `модель ${data.modelId}${route ? ` (${route})` : ""}: ${data.error}`;
    (answered ? recovered : errors).push(line);
  });
  return { errors, recovered };
}
