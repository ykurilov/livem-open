"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { ArchiveIcon as Archive, TrashIcon as Trash } from "@phosphor-icons/react/dist/ssr";
import { CopyableLink } from "@/ui";
import { Alert, Button, Field, Input } from "@/ui/primitives";
import { submitKeepingFields } from "@/ui/submit-keeping-fields";
import { createLinkAction, removeLinkAction, type LinkActionState } from "./actions";
import { keepingFormOnSendFailure } from "@/ui/form-upload";

export interface LabeledLinkView {
  id: string;
  label: string;
  hasPeople: boolean;
  urls: Array<{ channel: string; channelLabel: string; url: string }>;
}

/** «Новая ссылка» с меткой и список действующих меток. Метку с людьми можно только отправить в архив. */
export function LabeledLinks(props: { leadMagnetId: string; links: LabeledLinkView[] }) {
  const form = useRef<HTMLFormElement>(null);
  // Ссылка создана — поле метки пустеет; не создана — метка остаётся для повтора
  const [state, formAction, pending] = useActionState<LinkActionState, FormData>(async (previous, formData) => {
    const next = await keepingFormOnSendFailure(createLinkAction.bind(null, props.leadMagnetId))(previous, formData);
    if (next.created !== undefined) form.current?.reset();
    return next;
  }, {});

  return (
    <div className="flex flex-col gap-[var(--yk-space-4)]">
      <form ref={form} onSubmit={submitKeepingFields(formAction)} className="flex max-w-xl flex-col gap-1">
        {/* Подсказка под строкой, а не внутри поля: иначе кнопка стоит ниже поля, а не рядом */}
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field label="Для кого ссылка">
              <Input name="label" autoComplete="off" maxLength={100} placeholder="Блогер Маша" aria-describedby="labeled-link-hint" />
            </Field>
          </div>
          <Button type="submit" loading={pending}>
            Новая ссылка
          </Button>
        </div>
        <p id="labeled-link-hint" className="yk-field__hint">
          Своя ссылка для блогера или объявления: в отчёте будет видно, сколько людей пришло по ней.
        </p>
      </form>
      {state.error ? (
        <Alert variant="danger" title="Ссылка не создана">
          {state.error}
        </Alert>
      ) : null}
      {props.links.length === 0 ? (
        <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">Ссылок с метками пока нет.</p>
      ) : (
        <ul className="flex flex-col gap-3 text-[length:var(--yk-text-small-size)]" aria-label="Ссылки с метками">
          {props.links.map((link) => (
            <LabeledLinkRow key={link.id} leadMagnetId={props.leadMagnetId} link={link} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LabeledLinkRow({ leadMagnetId, link }: { leadMagnetId: string; link: LabeledLinkView }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Удаление не вернуть: сначала спросить прямо в строке, без отдельного окна
  const [confirming, setConfirming] = useState(false);
  const how = link.hasPeople ? "archive" : "delete";

  const remove = () =>
    startTransition(async () => {
      try {
        const result = await removeLinkAction(leadMagnetId, link.id, how);
        setError(result.error ?? null);
        setConfirming(false);
      } catch {
        setError("Нет связи с сервером. Попробуйте ещё раз.");
      }
    });

  return (
    <li className="flex flex-col gap-1 rounded-[var(--yk-radius-lg)] border border-[var(--yk-border)] p-3" data-testid="labeled-link">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{link.label}</span>
        {confirming ? null : (
          // Архив ничего не ломает (ссылка работает и считается в отчёте) — сразу; удаление не вернуть — сначала спросить
          <Button type="button" size="sm" variant="secondary" loading={pending} onClick={() => (link.hasPeople ? remove() : setConfirming(true))}>
            {link.hasPeople ? <Archive aria-hidden /> : <Trash aria-hidden />}
            {link.hasPeople ? "В архив" : "Удалить"}
          </Button>
        )}
      </div>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--yk-radius-md)] bg-[var(--yk-surface-2)] p-2" role="group" aria-label="Подтверждение">
          <span className="grow">Удалить ссылку «{link.label}»? Вернуть её не получится.</span>
          <Button type="button" size="sm" variant="destructive" loading={pending} onClick={remove}>
            Удалить
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => setConfirming(false)}>
            Отмена
          </Button>
        </div>
      ) : null}
      {link.urls.length === 0 ? <span>Привяжите бота, чтобы получить ссылки</span> : null}
      {link.urls.map((entry) => (
        <span key={entry.channel} className="flex flex-col">
          <span className="text-[var(--yk-muted)]">{entry.channelLabel}</span>
          <CopyableLink url={entry.url} channel={`${link.label}, ${entry.channelLabel}`} testId={`labeled-link-${entry.channel}`} />
        </span>
      ))}
      {link.hasPeople ? (
        <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          По этой ссылке уже приходили люди: её можно только отправить в архив, в отчёте она останется.
        </span>
      ) : null}
      {error ? (
        <Alert variant="danger" title="Не получилось">
          {error}
        </Alert>
      ) : null}
    </li>
  );
}
