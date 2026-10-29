"use client";

import { startTransition, useActionState, useState } from "react";
import { Alert, Button, Field, Input } from "@/ui/primitives";
import { Select, type SelectOption } from "@/ui";
import { connectBotAction, type ConnectBotState } from "./actions";

// Откуда взять токен и как он выглядит: у каждого мессенджера по-своему
const TOKEN_HELP: Record<string, { label: string; hint: string; placeholder: string; steps?: string[] }> = {
  telegram: {
    label: "Токен бота",
    hint: "Создайте бота у @BotFather командой /newbot и вставьте токен сюда.",
    placeholder: "123456789:AA…",
  },
  vk: {
    label: "Ключ доступа сообщества",
    hint: "Ключ из шага 3. Без любой из трёх галочек бот не заработает: приложение скажет, какой не хватает.",
    // Шаги и права сверены с документацией ВК (dev.vk.com): кнопкам нужны «Возможности ботов», серверу событий — управление сообществом
    steps: [
      "В сообществе откройте Управление → Сообщения и включите «Сообщения сообщества».",
      "Там же откройте «Настройки для бота» и включите «Возможности ботов» — без этого у бота не будет кнопок.",
      "Откройте Управление → Дополнительно → Работа с API → Ключи доступа и нажмите «Создать ключ». Отметьте три права: управление сообществом, сообщения сообщества и фотографии. Подтвердите создание по СМС или в приложении ВКонтакте.",
      "Скопируйте ключ и вставьте его сюда.",
    ],
    placeholder: "vk1.a.…",
  },
  max: {
    label: "Токен бота",
    hint: "Создайте бота в кабинете Max для бизнеса (business.max.ru) и скопируйте его токен.",
    placeholder: "Токен из кабинета Max",
  },
};

export function ConnectBotForm({ channels }: { channels: SelectOption[] }) {
  const [token, setToken] = useState("");
  const [state, formAction, pending] = useActionState<ConnectBotState, FormData>(async (previous, formData) => {
    const next = await connectBotAction(previous, formData);
    if (next.connected) setToken("");
    return next;
  }, {});
  const [channel, setChannel] = useState(channels[0]?.value ?? "");
  // Вопрос «подключить всё равно?» относится к тому токену и мессенджеру, с которыми его задали: после правки или отмены он снимается
  const [dismissed, setDismissed] = useState<ConnectBotState | null>(null);
  const conflict = state.conflict && state !== dismissed ? state.conflict : null;

  const help = TOKEN_HELP[channel] ?? TOKEN_HELP.telegram!;

  return (
    // Без `action`: React после действия сбрасывает форму, и выбор мессенджера возвращался к Telegram, а токен оставался
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // С нажатой кнопкой: «Подключить всё равно» передаёт `force` только так
        const formData = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
        startTransition(() => formAction(formData));
      }}
      className="flex max-w-xl flex-col gap-[var(--yk-space-4)]"
    >
      <input type="hidden" name="channel" value={channel} />
      <div className="flex flex-col gap-1">
        <span className="text-[length:var(--yk-text-small-size)] font-semibold">Мессенджер</span>
        <Select
          options={channels}
          value={channel}
          onValueChange={(value) => {
            setChannel(value);
            setDismissed(state);
          }}
          aria-label="Мессенджер"
        />
      </div>
      {help.steps ? (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-[length:var(--yk-text-small-size)]" aria-label="Как подключить">
          {help.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
      <Field label={help.label} hint={help.hint} required>
        <Input
          name="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={help.placeholder}
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            setDismissed(state);
          }}
        />
      </Field>
      {state.error ? (
        <Alert variant="danger" title="Не получилось подключить">
          {state.error}
        </Alert>
      ) : null}
      {conflict ? (
        <Alert variant="warm" title="Бот уже используется">
          <p>{conflict}</p>
          <div className="mt-[var(--yk-space-4)] flex gap-[var(--yk-space-4)]">
            <Button type="submit" name="force" value="1" variant="destructive" loading={pending}>
              Подключить всё равно
            </Button>
            <Button type="button" variant="secondary" onClick={() => setDismissed(state)}>
              Отмена
            </Button>
          </div>
        </Alert>
      ) : null}
      {state.connected ? (
        <Alert variant="success" title="Бот подключён">
          {state.connected}
        </Alert>
      ) : null}
      {conflict ? null : (
        <div>
          <Button type="submit" loading={pending}>
            Подключить
          </Button>
        </div>
      )}
    </form>
  );
}
