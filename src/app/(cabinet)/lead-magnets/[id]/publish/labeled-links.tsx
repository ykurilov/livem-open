"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert, Button, Field, Input } from "@/ui/primitives";
import { createLinkAction, removeLinkAction, type LinkActionState } from "./actions";

export interface LabeledLinkView {
  id: string;
  label: string;
  hasPeople: boolean;
  urls: Array<{ channel: string; channelLabel: string; url: string }>;
}

/** «Новая ссылка» с меткой и список действующих меток. Метку с людьми можно только отправить в архив. */
export function LabeledLinks(props: { leadMagnetId: string; links: LabeledLinkView[] }) {
  const [state, formAction, pending] = useActionState<LinkActionState, FormData>(
    createLinkAction.bind(null, props.leadMagnetId),
    {},
  );

  return (
    <div className="flex flex-col gap-[var(--yk-space-4)]">
      <form action={formAction} className="flex max-w-xl items-end gap-2">
        <div className="flex-1">
          <Field label="Метка новой ссылки" hint="Например, «Блогер Маша» или «Реклама ВК, октябрь».">
            <Input name="label" autoComplete="off" maxLength={100} placeholder="Блогер Маша" />
          </Field>
        </div>
        <Button type="submit" loading={pending}>
          Новая ссылка
        </Button>
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
  const how = link.hasPeople ? "archive" : "delete";

  const remove = () =>
    startTransition(async () => {
      const result = await removeLinkAction(leadMagnetId, link.id, how);
      setError(result.error ?? null);
    });

  return (
    <li className="flex flex-col gap-1 rounded-[var(--yk-radius-lg)] border border-[var(--yk-border)] p-3" data-testid="labeled-link">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{link.label}</span>
        <Button type="button" size="sm" variant="ghost" loading={pending} onClick={remove}>
          {link.hasPeople ? "В архив" : "Удалить"}
        </Button>
      </div>
      {link.urls.length === 0 ? <span>Привяжите бота, чтобы получить ссылки</span> : null}
      {link.urls.map((entry) => (
        <span key={entry.channel} className="flex flex-col">
          <span className="text-[var(--yk-muted)]">{entry.channelLabel}</span>
          <code className="select-all break-all" data-testid={`labeled-link-${entry.channel}`}>
            {entry.url}
          </code>
        </span>
      ))}
      {link.hasPeople ? (
        <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          По этой метке уже приходили люди: её можно только отправить в архив, в отчёте она останется.
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
