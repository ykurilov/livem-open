"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Input } from "@/ui/primitives";
import { saveSettingsAction, type SettingsFormState } from "./actions";

export interface SettingsFormValues {
  dailyLimitUsd: string;
  monthlyBudgetUsd: string;
  privacyPolicyUrl: string;
  alertChatId: string;
}

export function SettingsForm({ values }: { values: SettingsFormValues }) {
  const [state, formAction, pending] = useActionState<SettingsFormState, FormData>(saveSettingsAction, {});

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-[var(--yk-space-4)]">
      <Field label="Дневной лимит на человека, $" hint="Исчерпал — консультант предложит продолжить завтра утром." required>
        <Input name="dailyLimitUsd" inputMode="decimal" defaultValue={values.dailyLimitUsd} />
      </Field>
      <Field
        label="Месячный бюджет, $"
        hint="Тревоги на 50%, 80% и 100%. На 200% консультант останавливается. Пусто — бюджета нет."
      >
        <Input name="monthlyBudgetUsd" inputMode="decimal" defaultValue={values.monthlyBudgetUsd} />
      </Field>
      <Field label="Ссылка на политику обработки персональных данных" hint="Бот добавляет её к первому сообщению человеку.">
        <Input name="privacyPolicyUrl" type="url" placeholder="https://…" defaultValue={values.privacyPolicyUrl} />
      </Field>
      <Field label="Куда слать тревоги" hint="Номер чата Telegram, куда бот тревог пишет о бюджете и сбоях.">
        <Input name="alertChatId" placeholder="-1001234567890" defaultValue={values.alertChatId} />
      </Field>
      {state.error ? (
        <Alert variant="danger" title="Не сохранено">
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
