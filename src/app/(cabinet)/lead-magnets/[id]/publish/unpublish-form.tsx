"use client";

import { useActionState } from "react";
import { Alert, Button } from "@/ui/primitives";
import { ACTION_SEND_FAILED, keepingFormOnSendFailure } from "@/ui/form-upload";
import { unpublishAction, type UnpublishState } from "./actions";

/** «Снять с публикации» с пояснением и понятной ошибкой. */
export function UnpublishForm({ leadMagnetId }: { leadMagnetId: string }) {
  const [state, formAction, pending] = useActionState<UnpublishState, FormData>(
    keepingFormOnSendFailure(unpublishAction.bind(null, leadMagnetId), ACTION_SEND_FAILED),
    {},
  );

  return (
    <form action={formAction} className="mt-[var(--yk-space-4)] flex flex-col gap-2 border-t border-[var(--yk-border)] pt-[var(--yk-space-4)]">
      {/* Кнопка и её последствия — одной строкой: видно, что это отдельное действие, а не продолжение формы выше */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="submit" variant="secondary" size="sm" loading={pending}>
          Снять с публикации
        </Button>
        <span className="min-w-[min(100%,16rem)] flex-1 text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          Ссылки перестанут запускать лидмагнит, бот поведёт себя как без кода. Начатые разговоры доиграют.
        </span>
      </div>
      {state.error ? (
        <Alert variant="danger" title="Не получилось">
          {state.error}
        </Alert>
      ) : null}
    </form>
  );
}
