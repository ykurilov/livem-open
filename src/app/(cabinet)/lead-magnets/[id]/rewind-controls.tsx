"use client";

import { useState, type FormEvent } from "react";
import { Menu, type MenuEntry } from "@ykurilov/ds-react";
import { ClockIcon } from "@phosphor-icons/react";
import { Button, Input } from "@/ui/primitives";
import { parseRewindDuration } from "@/modules/consultant/rewind-duration";

const QUICK_STEPS = [
  { label: "+15 мин", ms: 15 * 60_000 },
  { label: "+1 ч", ms: 60 * 60_000 },
  { label: "+3 ч", ms: 3 * 60 * 60_000 },
];

export interface RewindControlsProps {
  /** Промотать часы тестового разговора вперёд на `ms`; `true` — часы сдвинулись. */
  onRewind(ms: number): Promise<boolean>;
  /** Промотать часы ровно к ближайшему сообщению, которое сценарий напишет сам. */
  onNextReminder(): void;
  /** Перейти к утру следующего дня программы; `null` — у лидмагнита нет дней или они кончились. */
  onNextDay: (() => void) | null;
  /** Перемотка идёт или разговор завершён — меню закрыто. */
  disabled: boolean;
}

/** «Промотать время» в поле ввода тестового разговора: быстрые шаги, к напоминанию, к следующему дню и своё время («1 ч 30 мин», «2 дня»). */
export function RewindControls({ onRewind, onNextReminder, onNextDay, disabled }: RewindControlsProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  const closeCustom = () => {
    setCustomOpen(false);
    setText("");
    setHint(null);
  };
  // Поле закрывается только после промотки: при отказе или обрыве связи длительность остаётся для повтора
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = parseRewindDuration(text);
    if (!result.ok) return setHint(result.hint);
    if (await onRewind(result.ms)) closeCustom();
  };

  const entries: MenuEntry[] = [
    ...QUICK_STEPS.map((step) => ({ label: step.label, onSelect: () => void onRewind(step.ms) })),
    "separator",
    { label: "К следующему напоминанию", onSelect: onNextReminder },
    ...(onNextDay ? [{ label: "К началу следующего дня", onSelect: onNextDay }] : []),
    "separator",
    { label: "Своё время…", onSelect: () => setCustomOpen(true) },
  ];

  if (customOpen)
    return (
      <form onSubmit={submit} className="flex min-w-0 flex-wrap items-center gap-2">
        <Input
          aria-label="Промотать на своё время"
          placeholder="1 ч 30 мин, 2 дня"
          value={text}
          autoFocus
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value);
            setHint(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeCustom();
          }}
          className="w-40 min-w-0"
        />
        <Button type="submit" variant="secondary" size="sm" disabled={disabled || text.trim() === ""}>
          Промотать
        </Button>
        <Button variant="secondary" size="sm" onClick={closeCustom}>
          Отмена
        </Button>
        {hint ? (
          <p role="alert" className="basis-full text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">
            {hint}
          </p>
        ) : null}
      </form>
    );

  return (
    <Menu
      label="Промотать время"
      entries={entries}
      trigger={
        <Button variant="secondary" size="sm" disabled={disabled} title="Промотать часы клиента вперёд: проверить, как агент пишет пропавшему клиенту">
          <ClockIcon aria-hidden />
          <span className="max-sm:hidden">Промотать время</span>
          {/* На телефоне поле узкое: «Время» помещается в одну строку с «Автоответом» */}
          <span className="sm:hidden">Время</span>
        </Button>
      }
    />
  );
}
