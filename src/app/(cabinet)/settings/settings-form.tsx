"use client";

import { useActionState, useState } from "react";
import { Alert, Button, Field, Input } from "@/ui/primitives";
import { submitKeepingFields } from "@/ui/submit-keeping-fields";
import { saveSettingsAction, type SettingsFormState } from "./actions";
import { keepingFormOnSendFailure } from "@/ui/form-upload";

export interface SettingsFormValues {
  dailyLimitUsd: string;
  monthlyBudgetUsd: string;
  privacyPolicyUrl: string;
  alertChatId: string;
}

export function SettingsForm({ values }: { values: SettingsFormValues }) {
  const [state, formAction, pending] = useActionState<SettingsFormState, FormData>(keepingFormOnSendFailure(saveSettingsAction), {});
  // «Сохранено» относится к значениям на момент нажатия: новая правка его снимает
  const [edited, setEdited] = useState<SettingsFormState | null>(null);

  return (
    <form onSubmit={submitKeepingFields(formAction)} onChange={() => setEdited(state)} className="flex max-w-xl flex-col gap-[var(--yk-space-4)]">
      <Field label="Дневной лимит на человека, $" hint="Исчерпал — консультант предложит продолжить завтра утром." required>
        <Input name="dailyLimitUsd" inputMode="decimal" defaultValue={values.dailyLimitUsd} />
      </Field>
      <Field
        label="Месячный бюджет, $"
        hint="Тревоги на 50%, 80% и 100%. На 200% консультант останавливается. Пусто — бюджета нет."
      >
        <Input name="monthlyBudgetUsd" inputMode="decimal" defaultValue={values.monthlyBudgetUsd} />
      </Field>
      {/* Без примеров внутри полей: серый пример легко принять за уже сохранённое значение */}
      <Field label="Ссылка на политику обработки персональных данных" hint="Бот добавляет её к первому сообщению человеку. Ссылка целиком, с https://">
        <Input name="privacyPolicyUrl" type="url" defaultValue={values.privacyPolicyUrl} />
      </Field>
      <Field
        label="Куда слать тревоги"
        hint="Номер чата Telegram, куда бот тревог пишет о бюджете и сбоях. Себе лично: напишите боту тревог /start и вставьте свой номер — его покажет бот @userinfobot. В группу: добавьте туда бота тревог, номер группы начинается с -100."
      >
        <Input name="alertChatId" defaultValue={values.alertChatId} />
      </Field>
      {state.error ? (
        <Alert variant="danger" title="Не сохранено">
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
