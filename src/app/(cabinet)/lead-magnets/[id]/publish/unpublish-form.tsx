"use client";

import { useActionState } from "react";
import { Alert, Button } from "@/ui/primitives";
import { unpublishAction, type UnpublishState } from "./actions";

/** «Снять с публикации» с пояснением и понятной ошибкой. */
export function UnpublishForm({ leadMagnetId }: { leadMagnetId: string }) {
  const [state, formAction, pending] = useActionState<UnpublishState>(unpublishAction.bind(null, leadMagnetId), {});

  return (
    <form action={formAction} className="mt-[var(--yk-space-4)] flex flex-col gap-1">
      <div>
        <Button type="submit" variant="secondary" loading={pending}>
          Снять с публикации
        </Button>
      </div>
      <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
        Ссылки перестанут запускать лидмагнит, бот поведёт себя как без кода. Начатые разговоры доиграют.
      </span>
      {state.error ? (
        <Alert variant="danger" title="Не получилось">
          {state.error}
        </Alert>
      ) : null}
    </form>
  );
}
