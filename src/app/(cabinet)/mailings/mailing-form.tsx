"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Alert, Button, Field, Input, Textarea } from "@/ui/primitives";
import { Select } from "@/ui";
import { Checkbox } from "@/ui/checkbox";
import { findTestRecipientsAction, saveMailingAction, type MailingFormState } from "./actions";
import type { TestRecipientOption } from "./test-recipient-option";

export interface MailingFormProps {
  /** Пусто — новая рассылка. */
  mailingId: string;
  text: string;
  /** Имя прикреплённого файла, если картинка уже есть. */
  imageName: string | null;
  /** Фильтр получателей в JSON — тот, что сейчас на странице. */
  filterJson: string;
  recipientCount: number;
  /** Первые по имени и последний, кому слали пробу; остальных находит поиск. */
  testRecipients: TestRecipientOption[];
  testPersonId: string | null;
  requestId: string;
}

/** Пауза после ввода, прежде чем искать: не дёргать базу на каждую букву. */
const SEARCH_DELAY_MS = 300;

export function MailingForm(props: MailingFormProps) {
  const [state, save, pending] = useActionState<MailingFormState, FormData>(saveMailingAction, {});
  const [tester, setTester] = useState(props.testRecipients.find((option) => option.id === props.testPersonId) ?? null);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState(props.testRecipients);
  const imageInput = useRef<HTMLInputElement>(null);
  const [imageFile, setImageFile] = useState<string | null>(null);

  // Поиск по имени: база может быть большой, в выпадающий список помещаются только первые
  useEffect(() => {
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const options = search.trim() ? await findTestRecipientsAction(search) : props.testRecipients;
        if (current) setFound(options);
      } catch {
        // Сеть моргнула: остаётся прежний список, следующая буква поищет снова
      }
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [search, props.testRecipients]);

  // Выбранный остаётся в списке, даже если новый поиск его не нашёл
  const options = tester && !found.some((option) => option.id === tester.id) ? [tester, ...found] : found;
  const testPersonId = tester?.id ?? "";

  return (
    // После действия React сбрасывает форму, и поле файла пустеет без события «change»: подпись следует за сбросом
    <form action={save} onReset={() => setImageFile(null)} className="flex flex-col gap-[var(--yk-space-6)]">
      <input type="hidden" name="mailingId" value={props.mailingId} />
      <input type="hidden" name="filter" value={props.filterJson} />
      <input type="hidden" name="requestId" value={props.requestId} />
      <input type="hidden" name="testPersonId" value={testPersonId} />

      <Field label="Текст" hint="Ссылки пишите прямо в тексте — мессенджер сделает их кликабельными." required>
        <Textarea name="text" rows={6} required defaultValue={props.text} />
      </Field>

      <Field label="Картинка" hint="Одна, PNG, JPG, GIF или WebP до 10 МБ. Можно без картинки.">
        <div className="flex flex-col gap-2">
          {props.imageName ? (
            <Checkbox name="removeImage">Убрать прикреплённую картинку ({props.imageName})</Checkbox>
          ) : null}
          <div className="flex items-center gap-[var(--yk-space-4)]">
            {/* Системный выбор файла спрятан: его подписи на языке браузера, а нужна кнопка в стиле кабинета */}
            <input
              ref={imageInput}
              type="file"
              name="image"
              accept="image/png,image/jpeg,image/gif,image/webp"
              aria-label="Картинка"
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => setImageFile(event.target.files?.[0]?.name ?? null)}
            />
            <Button type="button" variant="secondary" onClick={() => imageInput.current?.click()}>
              {imageFile ? "Выбрать другую" : "Выбрать картинку"}
            </Button>
            <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{imageFile ?? "Файл не выбран"}</span>
          </div>
        </div>
      </Field>

      <div className="flex flex-wrap items-end gap-[var(--yk-space-4)]">
        <Field label="Найти себя" hint="Часть имени — список ниже сузится.">
          <Input
            type="search"
            aria-label="Найти себя"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            // Enter в поиске не отправляет форму рассылки
            onKeyDown={(event) => event.key === "Enter" && event.preventDefault()}
            className="w-52"
          />
        </Field>
        <Field label="Кому прислать пробу" hint="Выберите себя: вы есть в базе, если писали своему боту.">
          <Select
            aria-label="Кому прислать пробу"
            placeholder={options.length ? "Выберите себя из базы" : "Никого не нашли"}
            value={testPersonId}
            onValueChange={(id) => setTester(options.find((option) => option.id === id) ?? null)}
            options={options.map((person) => ({ value: person.id, label: person.label }))}
          />
        </Field>
        <Button type="submit" name="intent" value="test" variant="secondary" disabled={pending}>
          Отправить себе
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-[var(--yk-space-4)]">
        <Field label="Время по Москве" hint="Для отложенной отправки.">
          <Input type="datetime-local" name="at" aria-label="Время по Москве" className="w-60" />
        </Field>
        <Button type="submit" name="intent" value="schedule" variant="secondary" disabled={pending}>
          Запланировать
        </Button>
      </div>

      {state.error ? <Alert variant="danger" title={state.error} /> : null}

      <div className="flex flex-wrap gap-[var(--yk-space-4)]">
        <Button type="submit" name="intent" value="now" disabled={pending || props.recipientCount === 0}>
          Отправить сейчас ({props.recipientCount})
        </Button>
        <Button type="submit" name="intent" value="save" variant="ghost" disabled={pending}>
          Сохранить черновик
        </Button>
      </div>
    </form>
  );
}
