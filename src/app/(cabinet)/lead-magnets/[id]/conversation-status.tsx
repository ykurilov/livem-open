import type { ReactNode } from "react";

/**
 * Строка над перепиской «Разговора»: где клиент по сценарию — день и этап. Нечего сказать — строки нет.
 * «Начать заново» — в общей строке над колонками (editor-header.tsx).
 */
export function ConversationStatus({ children }: { children: ReactNode }) {
  return <p className="truncate pl-3 text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{children}</p>;
}
