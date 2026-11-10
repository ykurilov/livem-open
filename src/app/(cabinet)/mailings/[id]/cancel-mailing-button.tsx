"use client";

import { useActionState } from "react";
import { Alert, Button } from "@/ui/primitives";
import { ACTION_SEND_FAILED, keepingFormOnSendFailure } from "@/ui/form-upload";
import { cancelMailingAction, type MailingFormState } from "../actions";

/** «Отменить» у запланированной рассылки: сбой связи — ошибка у кнопки, а не экран сбоя. */
export function CancelMailingButton({ mailingId }: { mailingId: string }) {
  const [state, cancel, pending] = useActionState<MailingFormState, FormData>(
    keepingFormOnSendFailure(cancelMailingAction.bind(null, mailingId), ACTION_SEND_FAILED),
    {},
  );
  return (
    <form action={cancel} className="flex flex-col items-start gap-[var(--yk-space-2)]">
      {state.error ? <Alert variant="danger" title="Рассылка не отменена">{state.error}</Alert> : null}
      <Button type="submit" variant="destructive" loading={pending}>
        Отменить
      </Button>
      <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">До этого времени рассылку можно отменить — никто её не получит.</span>
    </form>
  );
}
