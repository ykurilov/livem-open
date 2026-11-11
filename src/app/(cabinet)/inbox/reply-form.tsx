"use client";

import { useActionState, useRef, useState } from "react";
import { Alert, Button, Field, Textarea } from "@/ui/primitives";
import { useRememberedDraft } from "@/ui/remembered-draft";
import { submitKeepingFields } from "@/ui/submit-keeping-fields";
import { replyAction, type InboxReplyState } from "./actions";

export function ReplyForm(props: { personId: string; seenUpTo: string; requestId: string }) {
  // Черновик — свой у каждого человека и переживает переход к другой переписке и перезагрузку
  const [text, setText] = useRememberedDraft(`inbox-reply:${props.personId}`);
  const latestText = useRef(text);
  latestText.current = text;
  // «Прочитано до» — на момент, когда эксперт начал писать: страница обновляется сама, и вопрос, пришедший за это время,
  // не должен считаться отвеченным этим ответом
  const [seenUpTo, setSeenUpTo] = useState<string | null>(null);
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
      if (latestText.current === sent) setSeenUpTo(null);
      setText((current) => (current === sent ? "" : current));
      setRequestId(crypto.randomUUID());
    }
    // Ушёл прежний вариант, поправленный текст остаётся в поле: «Отправить» ещё раз отправит уже его
    if (next.earlierSent) setRequestId(crypto.randomUUID());
    return next;
  }, {});
  function changeText(value: string) {
    setText(value);
    setSeenUpTo((current) => (value.trim() ? (current ?? props.seenUpTo) : null));
  }

  return (
    <form onSubmit={submitKeepingFields(reply)} className="flex flex-col gap-[var(--yk-space-4)]">
      <input type="hidden" name="personId" value={props.personId} />
      <input type="hidden" name="seenUpTo" value={seenUpTo ?? props.seenUpTo} />
      <input type="hidden" name="requestId" value={requestId} />
      <Field label="Ваш ответ" hint="Уйдёт от имени бота. Сегодня автоответ этому человеку больше не придёт.">
        <Textarea name="text" rows={3} required value={text} onChange={(event) => changeText(event.target.value)} />
      </Field>
      {state.error ? <Alert variant="danger" title={state.error} /> : null}
      <Button type="submit" loading={sending} className="w-fit">
        Отправить
      </Button>
    </form>
  );
}
