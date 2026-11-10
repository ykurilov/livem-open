"use client";

import { useActionState, useEffect, useState } from "react";
import { Dialog } from "@ykurilov/ds-react";
import { Alert, Button } from "@/ui/primitives";
import { ACTION_SEND_FAILED, keepingFormOnSendFailure } from "@/ui/form-upload";
import { startOverAction, type StartOverState } from "./actions";

/** Кнопка «Начать заново» с подтверждением. */
export function StartOverButton({ personId, name }: { personId: string; name: string }) {
  const [state, startOver, pending] = useActionState<StartOverState, FormData>(
    keepingFormOnSendFailure(startOverAction.bind(null, personId), ACTION_SEND_FAILED),
    {},
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => {
    if (state.done) setConfirmOpen(false);
  }, [state]);

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button type="button" variant="secondary" onClick={() => setConfirmOpen(true)}>
        Начать заново
      </Button>
      <span className="max-w-[15rem] text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)] sm:text-right">Лидмагнит пойдёт с начала. Поля и переписки останутся.</span>
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title={`Начать разговор с «${name}» заново?`}>
        <p className="app-muted mb-4">Идущий разговор закончится как «не завершил».</p>
        <div>
          Следующий «Старт» или ссылка начнут лидмагнит с чистого листа, даже если программу человек уже прошёл. Поля, факты и
          прошлые переписки в карточке останутся.
        </div>
        {state.error ? (
          <div className="mt-4">
            <Alert variant="danger" title={state.error} />
          </div>
        ) : null}
        <div className="app-dialog-actions">
          <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)}>
            Отмена
          </Button>
          <form action={startOver}>
            <Button type="submit" variant="destructive" loading={pending}>
              Начать заново
            </Button>
          </form>
        </div>
      </Dialog>
    </div>
  );
}
