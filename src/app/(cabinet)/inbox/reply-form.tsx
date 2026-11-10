"use client";

import { useActionState, useState } from "react";
import { Alert, Button, Field, Textarea } from "@/ui/primitives";
import { submitKeepingFields } from "@/ui/submit-keeping-fields";
import { replyAction, type InboxReplyState } from "./actions";

export function ReplyForm(props: { personId: string; seenUpTo: string; requestId: string }) {
  // «Прочитано до» — на момент, когда эксперт начал писать: страница обновляется сама, и вопрос, пришедший за это время,
  // не должен считаться отвеченным этим ответом
  const [draft, setDraft] = useState<{ text: string; seenUpTo: string | null }>({ text: "", seenUpTo: null });
  // Ключ повтора живёт до успеха: страница обновляется сама, и повтор после обрыва сети не должен уйти вторым ответом
  const [requestId, setRequestId] = useState(props.requestId);
  // Ответ ушёл — поле пустеет, если эксперт не начал за это время новый; не ушёл — текст остаётся для повтора
  const [state, reply, sending] = useActionState<InboxReplyState, FormData>(async (previous, formData) => {
    let next: InboxReplyState;
    try {
      next = await replyAction(previous, formData);
    } catch {
      // Сбой сервера или связи: текст остаётся в поле, ключ повтора тот же — второй раз ответ не уйдёт
      return { error: "Не получилось отправить ответ. Нажмите «Отправить» ещё раз." };
    }
    const sent = formData.get("text");
    if (next.sent) {
      setDraft((current) => (current.text === sent ? { text: "", seenUpTo: null } : current));
      setRequestId(crypto.randomUUID());
    }
    // Ушёл прежний вариант, поправленный текст остаётся в поле: «Отправить» ещё раз отправит уже его
    if (next.earlierSent) setRequestId(crypto.randomUUID());
    return next;
  }, {});
  function changeText(text: string) {
    setDraft((current) => ({ text, seenUpTo: text.trim() ? (current.seenUpTo ?? props.seenUpTo) : null }));
  }

  return (
    <form onSubmit={submitKeepingFields(reply)} className="flex flex-col gap-[var(--yk-space-4)]">
      <input type="hidden" name="personId" value={props.personId} />
      <input type="hidden" name="seenUpTo" value={draft.seenUpTo ?? props.seenUpTo} />
      <input type="hidden" name="requestId" value={requestId} />
      <Field label="Ваш ответ" hint="Уйдёт от имени бота. Сегодня автоответ этому человеку больше не придёт.">
        <Textarea name="text" rows={3} required value={draft.text} onChange={(event) => changeText(event.target.value)} />
      </Field>
      {state.error ? <Alert variant="danger" title={state.error} /> : null}
      <Button type="submit" loading={sending} className="w-fit">
        Отправить
      </Button>
    </form>
  );
}
