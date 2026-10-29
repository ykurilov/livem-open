"use client";

import { useActionState, useState } from "react";
import { Alert, Button } from "@/ui/primitives";
import type { NoCodeMode } from "@/modules/channels";
import { Select, type SelectOption } from "@/ui";
import { deleteBotAction, saveNoCodeAction, type BotSettingsState } from "../actions";

const MODES: Array<SelectOption & { value: NoCodeMode; hint: string }> = [
  { value: "nothing", label: "Ничего", hint: "Бот молчит, сообщение попадает во «Входящие»." },
  { value: "default", label: "Лидмагнит по умолчанию", hint: "Бот сразу начинает выбранный лидмагнит." },
  { value: "menu", label: "Меню", hint: "Бот показывает кнопки с опубликованными лидмагнитами этого бота." },
];

export function BotSettingsForm(props: {
  botId: string;
  mode: NoCodeMode;
  defaultLeadMagnetId: string | null;
  leadMagnets: SelectOption[];
}) {
  const [state, formAction, pending] = useActionState<BotSettingsState, FormData>(
    saveNoCodeAction.bind(null, props.botId),
    {},
  );
  const [mode, setMode] = useState<string>(props.mode);
  const [defaultLeadMagnetId, setDefaultLeadMagnetId] = useState(props.defaultLeadMagnetId ?? "");
  const hint = MODES.find((entry) => entry.value === mode)?.hint;

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-[var(--yk-space-4)]">
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="defaultLeadMagnetId" value={mode === "default" ? defaultLeadMagnetId : ""} />
      <div className="flex flex-col gap-1">
        <span className="text-[length:var(--yk-text-small-size)] font-semibold">Что делает бот</span>
        <Select aria-label="Что делает бот без кода" options={MODES} value={mode} onValueChange={setMode} />
        {hint ? <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{hint}</span> : null}
      </div>
      {mode === "default" ? (
        <div className="flex flex-col gap-1">
          <span className="text-[length:var(--yk-text-small-size)] font-semibold">Лидмагнит по умолчанию</span>
          {props.leadMagnets.length === 0 ? (
            <span className="text-[length:var(--yk-text-small-size)]">К этому боту ещё не привязан ни один лидмагнит. Привяжите его на экране публикации.</span>
          ) : (
            <Select
              aria-label="Лидмагнит по умолчанию"
              placeholder="Выберите лидмагнит"
              options={props.leadMagnets}
              value={defaultLeadMagnetId}
              onValueChange={setDefaultLeadMagnetId}
            />
          )}
        </div>
      ) : null}
      {state.error ? (
        <Alert variant="danger" title="Не сохранилось">
          {state.error}
        </Alert>
      ) : null}
      {state.saved ? <Alert variant="success" title="Сохранено" /> : null}
      <div>
        <Button type="submit" loading={pending}>
          Сохранить
        </Button>
      </div>
    </form>
  );
}

function conversationsWord(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "разговоров";
  if (last === 1) return "разговор";
  if (last >= 2 && last <= 4) return "разговора";
  return "разговоров";
}

export function DeleteBotForm(props: { botId: string; publishedCount: number; activeConversations: number }) {
  const [state, formAction, pending] = useActionState<BotSettingsState, FormData>(deleteBotAction.bind(null, props.botId), {});

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-[var(--yk-space-4)]">
      <span className="text-[length:var(--yk-text-small-size)]">
        {props.publishedCount > 0
          ? "На этом боте есть опубликованные лидмагниты. Чтобы удалить бота, сначала снимите их с публикации."
          : "Бот перестанет принимать сообщения. Люди и переписка в базе останутся."}
      </span>
      {props.activeConversations > 0 ? (
        <Alert variant="warm" title={`Сейчас идёт ${props.activeConversations} ${conversationsWord(props.activeConversations)}`}>
          При удалении бота они закроются со статусом «не завершил», напоминания этим людям больше не придут.
        </Alert>
      ) : null}
      {state.error ? (
        <Alert variant="danger" title="Бот не удалён">
          {state.error}
        </Alert>
      ) : null}
      <div>
        <Button type="submit" variant="destructive" loading={pending}>
          Удалить бота
        </Button>
      </div>
    </form>
  );
}
