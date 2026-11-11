"use client";

import { useActionState, useState } from "react";
import { Alert, Button, Field, Input } from "@/ui/primitives";
import { Select, type SelectOption } from "@/ui";
import { submitKeepingFields } from "@/ui/submit-keeping-fields";
import { connectSenlerAction, disconnectSenlerAction, saveSenlerGroupsAction, type SenlerFormState } from "../senler-actions";
import { ACTION_SEND_FAILED, keepingFormOnSendFailure } from "@/ui/form-upload";

const NO_GROUP = "";
const AS_BOT = "";

/** Ключ Senler: первое подключение или замена ключа. */
export function SenlerKeyForm(props: { botId: string; connected: boolean }) {
  const [state, formAction, pending] = useActionState<SenlerFormState, FormData>(keepingFormOnSendFailure(connectSenlerAction.bind(null, props.botId)), {});
  const [apiKey, setApiKey] = useState("");
  const [dismissed, setDismissed] = useState<SenlerFormState | null>(null);
  // Ключ принят — из поля он убирается: незачем держать его на открытом экране
  const [answered, setAnswered] = useState(state);
  if (state !== answered) {
    setAnswered(state);
    if (state.saved) setApiKey("");
  }

  return (
    <form className="flex max-w-xl flex-col gap-[var(--yk-space-4)]" onSubmit={submitKeepingFields(formAction)}>
      <Field label={props.connected ? "Новый ключ Senler" : "Ключ Senler"} hint="В Senler: «Настройки» → «Работа с API» → создайте ключ и вставьте сюда." required>
        <Input
          name="apiKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setDismissed(state);
          }}
        />
      </Field>
      {state.error && state !== dismissed ? (
        <Alert variant="danger" title="Senler не подключён">
          {state.error}
        </Alert>
      ) : null}
      {state.saved && state !== dismissed ? (
        <Alert variant="success" title={state.replaced ? "Ключ Senler заменён" : "Ключ Senler принят"}>
          {state.replaced ? "Проверьте группы выше: у нового ключа они могут быть другими." : "Выберите группу подписчиков выше."}
        </Alert>
      ) : null}
      <div>
        <Button type="submit" loading={pending}>
          {props.connected ? "Заменить ключ" : "Подключить Senler"}
        </Button>
      </div>
    </form>
  );
}

/** Группа подписчиков бота и свои группы лидмагнитов — списком из Senler. */
export function SenlerGroupsForm(props: {
  botId: string;
  groups: SelectOption[];
  defaultGroupId: string | null;
  leadMagnets: Array<{ id: string; name: string; groupId: string | null }>;
}) {
  const [state, formAction, pending] = useActionState<SenlerFormState, FormData>(keepingFormOnSendFailure(saveSenlerGroupsAction.bind(null, props.botId)), {});
  const [defaultGroupId, setDefaultGroupId] = useState(props.defaultGroupId ?? NO_GROUP);
  const [leadMagnetGroups, setLeadMagnetGroups] = useState<Record<string, string>>(
    Object.fromEntries(props.leadMagnets.map((lead) => [lead.id, lead.groupId ?? AS_BOT])),
  );
  // «Сохранено» относится к выбору на момент нажатия: новый выбор его снимает
  const [edited, setEdited] = useState<SenlerFormState | null>(null);
  const known = new Set(props.groups.map((group) => group.value));
  // Группу удалили в Senler — показываем это в списке, а не пустое место
  const withMissing = (id: string): SelectOption[] => (id && !known.has(id) ? [{ value: id, label: "Группа удалена в Senler" }] : []);

  return (
    <form className="flex max-w-xl flex-col gap-[var(--yk-space-4)]" onSubmit={submitKeepingFields(formAction)}>
      <input type="hidden" name="defaultGroupId" value={defaultGroupId} />
      {Object.entries(leadMagnetGroups).map(([leadMagnetId, groupId]) => (
        <input key={leadMagnetId} type="hidden" name={`leadMagnetGroup:${leadMagnetId}`} value={groupId} />
      ))}
      <div className="flex flex-col gap-1">
        <span className="yk-mono-label">Группа подписчиков</span>
        <Select
          aria-label="Группа Senler по умолчанию"
          options={[{ value: NO_GROUP, label: "Не добавлять" }, ...withMissing(defaultGroupId), ...props.groups]}
          value={defaultGroupId}
          onValueChange={(value) => {
            setDefaultGroupId(value);
            setEdited(state);
          }}
        />
        <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          Кто начал разговор по ссылке лидмагнита, попадёт в эту группу. Метка ссылки уйдёт в Senler как источник.
        </span>
      </div>
      {props.leadMagnets.length > 0 ? (
        <div className="flex flex-col gap-[var(--yk-space-3)]">
          <span className="text-[length:var(--yk-text-small-size)] font-semibold">Своя группа у лидмагнита</span>
          {props.leadMagnets.map((lead) => (
            <div key={lead.id} className="flex flex-col gap-1">
              <span className="text-[length:var(--yk-text-small-size)]">{lead.name}</span>
              <Select
                aria-label={`Группа Senler для «${lead.name}»`}
                options={[{ value: AS_BOT, label: "Как у бота" }, ...withMissing(leadMagnetGroups[lead.id] ?? AS_BOT), ...props.groups]}
                value={leadMagnetGroups[lead.id] ?? AS_BOT}
                onValueChange={(value) => {
                  setLeadMagnetGroups((current) => ({ ...current, [lead.id]: value }));
                  setEdited(state);
                }}
              />
            </div>
          ))}
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
          Сохранить группы
        </Button>
      </div>
    </form>
  );
}

export function SenlerDisconnectForm(props: { botId: string }) {
  const [state, formAction, pending] = useActionState<SenlerFormState, FormData>(
    keepingFormOnSendFailure(disconnectSenlerAction.bind(null, props.botId), ACTION_SEND_FAILED),
    {},
  );
  return (
    <form action={formAction} className="flex flex-col gap-[var(--yk-space-4)]">
      <div>
        <Button type="submit" variant="secondary" loading={pending}>
          Отключить Senler
        </Button>
      </div>
      {state.error ? (
        <Alert variant="danger" title="Senler не отключён">
          {state.error}
        </Alert>
      ) : null}
    </form>
  );
}
