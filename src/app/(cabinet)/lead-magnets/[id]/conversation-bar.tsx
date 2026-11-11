"use client";

import type { ReactNode } from "react";
import { Button as DesignButton } from "@ykurilov/ds-react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";

/**
 * Строка над перепиской «Разговора»: слева — где клиент по сценарию (если есть что сказать), справа — «Начать заново».
 * Одна и та же в обычной проверке и в «Поменяемся ролями»: перезапуск всегда в одном месте, рядом с перепиской.
 */
export function ConversationBar({
  children,
  onRestart,
  restarting = false,
  restartDisabled = false,
}: {
  children?: ReactNode;
  onRestart(): void;
  restarting?: boolean;
  restartDisabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 pl-3">
      <p className="min-w-0 flex-1 truncate text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{children}</p>
      <DesignButton variant="secondary" size="sm" icon={ArrowCounterClockwiseIcon} className="shrink-0" loading={restarting} disabled={restartDisabled} onClick={onRestart}>
        Начать заново
      </DesignButton>
    </div>
  );
}
