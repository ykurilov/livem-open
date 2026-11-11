"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import { Dialog } from "@ykurilov/ds-react";
import { Alert, Button } from "@/ui/primitives";
import type { NoCodeMode } from "@/modules/channels";
import { Select, type SelectOption } from "@/ui";
import { deleteBotAction, saveNoCodeAction, type BotSettingsState } from "../actions";
import { ACTION_SEND_FAILED, keepingFormOnSendFailure } from "@/ui/form-upload";

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
    keepingFormOnSendFailure(saveNoCodeAction.bind(null, props.botId)),
    {},
  );
  const [mode, setMode] = useState<string>(props.mode);
  const [defaultLeadMagnetId, setDefaultLeadMagnetId] = useState(props.defaultLeadMagnetId ?? "");
  // «Сохранено» относится к выбору на момент нажатия: новый выбор его снимает
  const [edited, setEdited] = useState<BotSettingsState | null>(null);
  const hint = MODES.find((entry) => entry.value === mode)?.hint;

  return (
    <form
      className="flex max-w-xl flex-col gap-[var(--yk-space-4)]"
      onSubmit={(event) => {
        // Через action React после отправки сбрасывает форму, и список показывал бы «Ничего»
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => formAction(data));
      }}
    >
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="defaultLeadMagnetId" value={mode === "default" ? defaultLeadMagnetId : ""} />
      <div className="flex flex-col gap-1">
        <span className="yk-mono-label">Что делает бот</span>
        <Select
          aria-label="Что делает бот без кода"
          options={MODES}
          value={mode}
          onValueChange={(value) => {
            setMode(value);
            setEdited(state);
          }}
        />
        {hint ? <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{hint}</span> : null}
      </div>
      {mode === "default" ? (
        <div className="flex flex-col gap-1">
          <span className="yk-mono-label">Лидмагнит по умолчанию</span>
          {props.leadMagnets.length === 0 ? (
            <span className="text-[length:var(--yk-text-small-size)]">К этому боту ещё не привязан ни один лидмагнит. Привяжите его на экране публикации.</span>
          ) : (
            <Select
              aria-label="Лидмагнит по умолчанию"
              placeholder="Выберите лидмагнит"
              options={props.leadMagnets}
              value={defaultLeadMagnetId}
              onValueChange={(value) => {
                setDefaultLeadMagnetId(value);
                setEdited(state);
              }}
            />
          )}
        </div>
      ) : null}
      {state.error ? (
        <Alert variant="danger" title="Не сохранилось">
          {state.error}
        </Alert>
      ) : null}
      {state.saved && state !== edited ? <Alert variant="success" title="Сохранено" /> : null}
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

/**
 * «Удалить бота» — через подтверждение: удаление закрывает идущие разговоры, отменить его нельзя.
 * Пока на боте есть опубликованные лидмагниты, кнопка выключена, а рядом — какие снять с публикации.
 */
export function DeleteBotForm(props: { botId: string; published: Array<{ id: string; name: string }>; activeConversations: number }) {
  const [state, formAction, pending] = useActionState<BotSettingsState, FormData>(
    keepingFormOnSendFailure(deleteBotAction.bind(null, props.botId), ACTION_SEND_FAILED),
    {},
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const blocked = props.published.length > 0;
  const activeWarning =
    props.activeConversations > 0 ? (
      <Alert variant="warm" title={`Сейчас идёт ${props.activeConversations} ${conversationsWord(props.activeConversations)}`}>
        При удалении бота они закроются со статусом «не завершил», напоминания этим людям больше не придут.
      </Alert>
    ) : null;

  return (
    <div className="flex max-w-xl flex-col gap-[var(--yk-space-4)]">
      {blocked ? (
        <div id="delete-bot-blocked" className="flex flex-col gap-1 text-[length:var(--yk-text-small-size)]">
          <span>Сейчас удалить нельзя: бот ведёт опубликованные лидмагниты. Снимите их с публикации — и кнопка заработает.</span>
          <ul className="list-disc pl-5">
            {props.published.map((lead) => (
              <li key={lead.id}>
                <Link href={`/lead-magnets/${lead.id}/publish`} className="app-focus underline underline-offset-2">
                  {lead.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <span className="text-[length:var(--yk-text-small-size)]">Бот перестанет принимать сообщения. Люди и переписка в базе останутся.</span>
      )}
      {activeWarning}
      <div>
        <Button
          type="button"
          variant="destructive"
          disabled={blocked}
          aria-describedby={blocked ? "delete-bot-blocked" : undefined}
          onClick={() => setConfirmOpen(true)}
        >
          Удалить бота
        </Button>
      </div>
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Удалить бота?">
        <p className="app-muted mb-4">Бот перестанет принимать сообщения. Вернуть его можно, только подключив заново.</p>
        {activeWarning}
        {state.error ? (
          <Alert variant="danger" title="Бот не удалён" className="mt-[var(--yk-space-4)]">
            {state.error}
          </Alert>
        ) : null}
        <div className="app-dialog-actions">
          <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)}>
            Отмена
          </Button>
          <form action={formAction}>
            <Button type="submit" variant="destructive" loading={pending}>
              Удалить
            </Button>
          </form>
        </div>
      </Dialog>
    </div>
  );
}
