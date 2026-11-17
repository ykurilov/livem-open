"use client";

import { createContext, useContext, useState, useTransition } from "react";
import { Dialog } from "@ykurilov/ds-react";
import { GearSixIcon } from "@phosphor-icons/react";
import { Alert, Button, Field, Textarea } from "@/ui/primitives";
import { IconButton } from "@/ui/icon-button";
import { saveTestClientAction } from "../actions";
import { TEST_CLIENT_MAX_CHARS } from "@/modules/lead-magnets/test-client-limit";

export { TEST_CLIENT_MAX_CHARS };

interface TestClientState {
  leadMagnetId: string;
  /** Описание клиента; `null` — не задано, модель придумывает клиента сама. */
  description: string | null;
  /** Описание уже сохранено на сервере (окном или стартом «Поменяемся ролями»). */
  saved(description: string | null): void;
}

/** «Клиент для проверки» лидмагнита: одно описание для «Автоответа» и «Поменяемся ролями». */
export const TestClientContext = createContext<TestClientState | null>(null);

export const useTestClient = () => useContext(TestClientContext);

/** Шестерёнка в поле ввода «Проверки»: окно, где эксперт описывает клиента, которого играет модель. */
export function TestClientButton() {
  const state = useTestClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  if (!state) return null;

  const openDialog = () => {
    setText(state.description ?? "");
    setError(null);
    setOpen(true);
  };
  const save = () =>
    startSave(async () => {
      setError(null);
      let result: Awaited<ReturnType<typeof saveTestClientAction>>;
      try {
        result = await saveTestClientAction(state.leadMagnetId, text);
      } catch {
        result = { ok: false, error: "Нет связи. Проверьте интернет и попробуйте ещё раз." };
      }
      // При ошибке окно остаётся открытым с введённым текстом
      if (!result.ok) return setError(result.error);
      state.saved(text.trim() || null);
      setOpen(false);
    });

  return (
    <>
      <IconButton label="Клиент для проверки" icon={GearSixIcon} variant="secondary" size="sm" onClick={openDialog} />
      <Dialog open={open} onClose={() => !saving && setOpen(false)} title="Клиент для проверки">
        <p className="app-muted mb-4">
          Его сыграет агент в «Автоответе» и в «Поменяемся ролями». Живые клиенты лидмагнита этого описания не видят.
        </p>
        <Field label="Кто клиент" hint="Его ситуация, настроение, сомнения, как он пишет. Пусто — агент придумает сам.">
          <Textarea rows={5} maxLength={TEST_CLIENT_MAX_CHARS} value={text} disabled={saving} onChange={(event) => setText(event.target.value)} />
        </Field>
        {error ? (
          <div className="mt-4">
            <Alert variant="danger" title={error} />
          </div>
        ) : null}
        <div className="app-dialog-actions">
          <Button type="button" variant="secondary" disabled={saving} onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button type="button" loading={saving} onClick={save}>
            Сохранить
          </Button>
        </div>
      </Dialog>
    </>
  );
}
