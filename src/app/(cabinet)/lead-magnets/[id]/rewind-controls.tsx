"use client";

import { useState, type FormEvent } from "react";
import { Button, Input } from "@/ui/primitives";
import { parseRewindDuration } from "@/modules/consultant/rewind-duration";

const QUICK_STEPS = [
  { label: "+15 мин", ms: 15 * 60_000 },
  { label: "+1 ч", ms: 60 * 60_000 },
  { label: "+3 ч", ms: 3 * 60 * 60_000 },
];

export interface RewindControlsProps {
  /** Промотать часы тестового разговора вперёд на `ms`. */
  onRewind(ms: number): void;
  /** Промотать часы ровно к ближайшему сообщению, которое сценарий напишет сам. */
  onNextReminder(): void;
  /** Перемотка идёт или разговор завершён — кнопки закрыты. */
  disabled: boolean;
}

/** Быстрые «+15 мин / +1 ч / +3 ч» и поле «своё время» («1 ч 30 мин», «2 дня»): проверить, что агент пишет пропавшему клиенту. */
export function RewindControls({ onRewind, onNextReminder, disabled }: RewindControlsProps) {
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = parseRewindDuration(text);
    if (!result.ok) return setHint(result.hint);
    setHint(null);
    setText("");
    onRewind(result.ms);
  };

  return (
    <>
      {QUICK_STEPS.map((step) => (
        <Button key={step.ms} variant="secondary" size="sm" disabled={disabled} onClick={() => onRewind(step.ms)}>
          {step.label}
        </Button>
      ))}
      <Button variant="secondary" size="sm" disabled={disabled} onClick={onNextReminder}>
        К следующему напоминанию
      </Button>
      <form onSubmit={submit} className="flex min-w-0 items-center gap-2">
        <Input
          aria-label="Промотать на своё время"
          placeholder="Своё время: 1 ч 30 мин"
          value={text}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value);
            setHint(null);
          }}
          className="w-44 min-w-0 max-w-full"
        />
        <Button type="submit" variant="secondary" size="sm" disabled={disabled || text.trim() === ""}>
          Промотать
        </Button>
      </form>
      {hint ? (
        <p role="alert" className="basis-full text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">
          {hint}
        </p>
      ) : null}
    </>
  );
}
