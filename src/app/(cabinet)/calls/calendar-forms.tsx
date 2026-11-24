"use client";

import { PencilSimpleIcon as Pencil, TrashIcon as Trash } from "@phosphor-icons/react";
import { Checkbox, Dialog } from "@ykurilov/ds-react";
import { useActionState, useEffect, useState } from "react";
import { keepingFormOnSendFailure } from "@/ui/form-upload";
import { IconButton } from "@/ui/icon-button";
import { Alert, Button, Field, Input } from "@/ui/primitives";
import { Select, type SelectOption } from "@/ui/select";
import { submitKeepingFields } from "@/ui/submit-keeping-fields";
import { useHydrated } from "@/ui/use-hydrated";
import { deleteCallWindowAction, saveCallCalendarAction, saveCallWindowAction, type CalendarActionState } from "./actions";

/** Правка уводит действующие записи из окон: эксперт видит, какие, и решает. Записи при этом не отменяются. */
function OutsideConfirm({ state, pending, confirmLabel }: { state: CalendarActionState; pending: boolean; confirmLabel: string }) {
  if (!state.outside?.length) return null;
  return (
    <Alert variant="warm" title="Эти записи окажутся вне окон">
      <ul className="mb-2 list-disc pl-5">
        {state.outside.map((booking) => (
          <li key={booking.id}>
            {booking.label}
            {booking.personName ? ` — ${booking.personName}` : ""}
          </li>
        ))}
      </ul>
      <p className="mb-2">Записи останутся в силе: созвон состоится. Отменить запись можно во вкладке «Записи».</p>
      <Button type="submit" name="confirm" value="1" variant="secondary" loading={pending}>
        {confirmLabel}
      </Button>
    </Alert>
  );
}

export function CalendarSettingsForm({ timeZone, callMinutes, timeZones }: { timeZone: string; callMinutes: number; timeZones: SelectOption[] }) {
  const [state, formAction, pending] = useActionState<CalendarActionState, FormData>(keepingFormOnSendFailure(saveCallCalendarAction), {});
  const [zone, setZone] = useState(timeZone);
  const [edited, setEdited] = useState<CalendarActionState | null>(null);
  return (
    <form onSubmit={submitKeepingFields(formAction)} onChange={() => setEdited(state)} className="flex max-w-xl flex-col gap-[var(--yk-space-4)]">
      <Field label="Часовой пояс" hint="По нему вы задаёте окна, а консультант называет время людям.">
        <Select aria-label="Часовой пояс" options={timeZones} value={zone} onValueChange={(value) => { setZone(value); setEdited(state); }} />
      </Field>
      <input type="hidden" name="timeZone" value={zone} />
      <Field label="Длительность созвона, минут" hint="Окно режется на созвоны такой длины, встык.">
        <Input name="callMinutes" type="number" inputMode="numeric" min={10} max={240} step={5} defaultValue={callMinutes} />
      </Field>
      {state.error ? <Alert variant="danger" title="Не сохранено">{state.error}</Alert> : null}
      {state !== edited ? <OutsideConfirm state={state} pending={pending} confirmLabel="Всё равно сохранить" /> : null}
      {state.saved && state !== edited ? <Alert variant="success" title="Сохранено" /> : null}
      <div>
        <Button type="submit" loading={pending}>
          Сохранить
        </Button>
      </div>
    </form>
  );
}

export interface WindowFormValues {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  weekly: boolean;
}

function WindowForm({ window, defaultDate, onDone }: { window?: WindowFormValues; defaultDate: string; onDone(): void }) {
  const [state, formAction, pending] = useActionState<CalendarActionState, FormData>(keepingFormOnSendFailure(saveCallWindowAction.bind(null, window?.id ?? null)), {});
  useEffect(() => {
    if (state.saved) onDone();
  }, [state, onDone]);
  return (
    <form onSubmit={submitKeepingFields(formAction)} className="flex flex-col gap-[var(--yk-space-4)]">
      <Field label="День" hint={window?.weekly ? "Повторяющееся окно: с этого дня и каждую неделю дальше." : undefined}>
        <Input name="date" type="date" defaultValue={window?.date ?? defaultDate} required />
      </Field>
      <div className="grid grid-cols-2 gap-[var(--yk-space-3)]">
        <Field label="С">
          <Input name="startTime" type="time" step={300} defaultValue={window?.startTime ?? "10:00"} required />
        </Field>
        <Field label="До" hint="Раньше начала — окно до следующего дня.">
          <Input name="endTime" type="time" step={300} defaultValue={window?.endTime ?? "13:00"} required />
        </Field>
      </div>
      <Checkbox name="weekly" defaultChecked={window?.weekly ?? false}>
        Повторять каждую неделю
      </Checkbox>
      {state.error ? <Alert variant="danger" title="Окно не сохранено">{state.error}</Alert> : null}
      <OutsideConfirm state={state} pending={pending} confirmLabel="Всё равно сохранить" />
      <div className="app-dialog-actions">
        <Button type="button" variant="secondary" onClick={onDone}>
          Отмена
        </Button>
        <Button type="submit" loading={pending}>
          Сохранить окно
        </Button>
      </div>
    </form>
  );
}

/** «Добавить окно» (без `window`) или правка окна. */
export function WindowDialog({ window, defaultDate, label }: { window?: WindowFormValues; defaultDate: string; label: string }) {
  const hydrated = useHydrated();
  const [opened, setOpened] = useState(0);
  const [open, setOpen] = useState(false);
  const show = () => {
    setOpened((count) => count + 1);
    setOpen(true);
  };
  return (
    <>
      {window ? (
        <IconButton label={label} icon={Pencil} size="sm" disabled={!hydrated} onClick={show} />
      ) : (
        <Button variant="secondary" size="sm" disabled={!hydrated} onClick={show}>
          {label}
        </Button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={window ? "Окно для созвонов" : "Новое окно для созвонов"}>
        {open ? <WindowForm key={opened} window={window} defaultDate={defaultDate} onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function DeleteWindowForm({ windowId, weekly, onDone }: { windowId: string; weekly: boolean; onDone(): void }) {
  const [state, formAction, pending] = useActionState<CalendarActionState, FormData>(keepingFormOnSendFailure(deleteCallWindowAction.bind(null, windowId)), {});
  useEffect(() => {
    if (state.saved) onDone();
  }, [state, onDone]);
  return (
    <form onSubmit={submitKeepingFields(formAction)}>
      <p>{weekly ? "Окно повторяется каждую неделю — удалится во всех неделях." : "Окно удалится из календаря."}</p>
      {state.error ? <Alert variant="danger" title="Окно не удалено" className="mt-[var(--yk-space-4)]">{state.error}</Alert> : null}
      <div className="mt-[var(--yk-space-4)]">
        <OutsideConfirm state={state} pending={pending} confirmLabel="Всё равно удалить" />
      </div>
      <div className="app-dialog-actions">
        <Button type="button" variant="secondary" onClick={onDone}>
          Отмена
        </Button>
        <Button type="submit" variant="destructive" loading={pending}>
          Удалить окно
        </Button>
      </div>
    </form>
  );
}

export function DeleteWindowButton({ windowId, weekly, label }: { windowId: string; weekly: boolean; label: string }) {
  const hydrated = useHydrated();
  const [opened, setOpened] = useState(0);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        label={label}
        icon={Trash}
        size="sm"
        disabled={!hydrated}
        onClick={() => {
          setOpened((count) => count + 1);
          setOpen(true);
        }}
      />
      <Dialog open={open} onClose={() => setOpen(false)} title="Удалить окно?">
        {open ? <DeleteWindowForm key={opened} windowId={windowId} weekly={weekly} onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}
