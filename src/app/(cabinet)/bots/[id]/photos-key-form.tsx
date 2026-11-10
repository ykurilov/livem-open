"use client";

import { useActionState, useState } from "react";
import { Alert, Button, Field, Input } from "@/ui/primitives";
import { submitKeepingFields } from "@/ui/submit-keeping-fields";
import { replaceBotTokenAction, type BotSettingsState } from "../actions";
import { keepingFormOnSendFailure } from "@/ui/form-upload";
import { VkKeyRights } from "../vk-key-rights";

/** Бот ВК без права «Фотографии»: что это значит и новый ключ, который это право добавит. */
export function PhotosKeyForm(props: { botId: string }) {
  const [state, formAction, pending] = useActionState<BotSettingsState, FormData>(keepingFormOnSendFailure(replaceBotTokenAction.bind(null, props.botId)), {});
  const [token, setToken] = useState("");
  const [dismissed, setDismissed] = useState<BotSettingsState | null>(null);

  return (
    <form className="flex max-w-xl flex-col gap-[var(--yk-space-4)]" onSubmit={submitKeepingFields(formAction)}>
      <Alert variant="warm" title="Бот не присылает картинки">
        У ключа сообщества нет права «Фотографии». Бот работает, но картинки лидмагнитов люди не получают: ответы приходят текстом.
      </Alert>
      <div className="text-[length:var(--yk-text-small-size)]">
        Чтобы бот присылал картинки, в сообществе откройте Управление → Дополнительно → Работа с API → Ключи доступа, создайте новый ключ и отметьте права:
        <VkKeyRights />
        Вставьте новый ключ сюда — бот останется тем же, со всеми настройками и переписками.
      </div>
      <Field label="Новый ключ доступа сообщества" required>
        <Input
          name="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="vk1.a.…"
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            setDismissed(state);
          }}
        />
      </Field>
      {state.error && state !== dismissed ? (
        <Alert variant="danger" title="Ключ не заменён">
          {state.error}
        </Alert>
      ) : null}
      <div>
        <Button type="submit" loading={pending}>
          Заменить ключ
        </Button>
      </div>
    </form>
  );
}
