"use client";

import { useActionState, useState } from "react";
import { Alert, Button } from "@/ui/primitives";
import { Select, type SelectOption } from "@/ui";
import { publishAction, type PublishState } from "./actions";
import { NO_BOT } from "./no-bot";

export interface ChannelChoice {
  channel: string;
  label: string;
  bots: SelectOption[];
  selected: string | null;
}

/** `draftVersionId` — версия черновика на странице: опубликуется только она. */
export function PublishForm(props: { leadMagnetId: string; draftVersionId: string; channels: ChannelChoice[]; published: boolean }) {
  const [state, formAction, pending] = useActionState<PublishState, FormData>(
    publishAction.bind(null, props.leadMagnetId),
    {},
  );
  const [selected, setSelected] = useState(() =>
    Object.fromEntries(props.channels.map((choice) => [choice.channel, choice.selected ?? NO_BOT])),
  );

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-[var(--yk-space-4)]">
      <input type="hidden" name="draftVersionId" value={props.draftVersionId} />
      {props.channels.map((choice) => (
        <div key={choice.channel} className="flex flex-col gap-1">
          <input type="hidden" name={`bot-${choice.channel}`} value={selected[choice.channel]} />
          <span className="text-[length:var(--yk-text-small-size)] font-semibold">Бот {choice.label}</span>
          <Select
            aria-label={`Бот ${choice.label}`}
            options={[{ value: NO_BOT, label: "Не выбран" }, ...choice.bots]}
            value={selected[choice.channel]}
            onValueChange={(value) => setSelected((current) => ({ ...current, [choice.channel]: value }))}
          />
        </div>
      ))}
      {state.error ? (
        <Alert variant="danger" title="Не получилось опубликовать">
          {state.error}
        </Alert>
      ) : null}
      {state.published ? (
        <Alert variant="success" title="Опубликовано">
          Новые разговоры пойдут по этой версии. Начатые доиграют на своей.
        </Alert>
      ) : null}
      <div>
        <Button type="submit" loading={pending}>
          {props.published ? "Опубликовать снова" : "Опубликовать"}
        </Button>
      </div>
    </form>
  );
}
