"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Textarea } from "@/ui/primitives";
import { replyAction, type InboxReplyState } from "./actions";

export function ReplyForm(props: { personId: string; seenUpTo: string; requestId: string }) {
  const [state, reply, sending] = useActionState<InboxReplyState, FormData>(replyAction, {});
  return (
    <form action={reply} className="flex flex-col gap-[var(--yk-space-4)]">
      <input type="hidden" name="personId" value={props.personId} />
      <input type="hidden" name="seenUpTo" value={props.seenUpTo} />
      <input type="hidden" name="requestId" value={props.requestId} />
      <Field label="Ваш ответ" hint="Уйдёт от имени бота. Сегодня автоответ этому человеку больше не придёт.">
        <Textarea name="text" rows={4} required />
      </Field>
      {state.error ? <Alert variant="danger" title={state.error} /> : null}
      <Button type="submit" loading={sending} className="w-fit">
        Отправить
      </Button>
    </form>
  );
}
