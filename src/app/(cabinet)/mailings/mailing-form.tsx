"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Alert, Button, Field, Input, Textarea } from "@/ui/primitives";
import { Checkbox } from "@/ui/checkbox";
import { isFileTooLarge, keepingFormOnSendFailure } from "@/ui/form-upload";
import { submitKeepingFields } from "@/ui/submit-keeping-fields";
import { IMAGE_MAX_BYTES } from "@/modules/images/image-limits";
import { findTestRecipientsAction, saveMailingAction, type MailingFormState } from "./actions";
import { useRecipientFilterApplied } from "./recipient-filter-applied";
import { recipientsPhrase } from "./recipients-phrase";
import type { TestRecipientOption } from "./test-recipient-option";
import { TestRecipientPicker } from "./test-recipient-picker";

export interface MailingFormProps {
  /** Пусто — новая рассылка. */
  mailingId: string;
  text: string;
  /** Имя прикреплённого файла, если картинка уже есть. */
  imageName: string | null;
  /** Фильтр получателей в JSON — тот, что сейчас на странице. */
  filterJson: string;
  recipientCount: number;
  /** Фильтр в адресе испорчен: получатели неизвестны, отправить и сохранить нельзя, пока эксперт не выберет заново. */
  recipientFilterBroken: boolean;
  /** Первые по имени и последний, кому слали пробу; остальных находит поиск. */
  testRecipients: TestRecipientOption[];
  testPersonId: string | null;
  /** Ключ повтора: новая рассылка берёт первый на всё открытие формы, у сохранённой — свежий на каждую отрисовку. */
  requestId: string;
}

const saveMailing = keepingFormOnSendFailure(saveMailingAction);

/** Пауза после ввода, прежде чем искать: не дёргать базу на каждую букву. */
const SEARCH_DELAY_MS = 300;

export function MailingForm(props: MailingFormProps) {
  const [state, save, pending] = useActionState<MailingFormState, FormData>(saveMailing, {});
  // Новая рассылка: страница перерисовывается («Показать» в «Кому»), а повтор после потерянного ответа не должен завести вторую.
  // Сохранённой ключ нужен только для пробы: после удачной страница та же, и следующая проба должна уйти
  const [newMailingRequestId] = useState(props.requestId);
  const requestId = props.mailingId ? props.requestId : newMailingRequestId;
  // Выбор в «Кому» не применён: отправка, план и черновик взяли бы прежний фильтр, а не тот, что виден
  const filterApplied = useRecipientFilterApplied() && !props.recipientFilterBroken;
  const scheduleButton = useRef<HTMLButtonElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [tester, setTester] = useState(props.testRecipients.find((option) => option.id === props.testPersonId) ?? null);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState(props.testRecipients);
  const imageInput = useRef<HTMLInputElement>(null);
  const [imageFile, setImageFile] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  // «Убрать» относится к картинке, что сейчас в черновике: новая картинка её заменяет, а не убирается вместе с ней
  const [removeImage, setRemoveImage] = useState(false);
  // Картинка в черновике сменилась (у сохранённой новое имя файла): выбор в поле больше не нужен, иначе её загрузили бы снова
  useEffect(() => {
    setRemoveImage(false);
    if (!props.imageName || !imageInput.current) return;
    imageInput.current.value = "";
    setImageFile(null);
  }, [props.imageName]);

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
    <form
      noValidate
      onSubmit={(event) => {
        // Без текста не уходит ни проба, ни рассылка, ни черновик: сказать об этом у самого поля, а не подсказкой браузера
        if (!textInput.current?.value.trim()) {
          event.preventDefault();
          setTextError("Напишите текст рассылки");
          textInput.current?.focus();
          return;
        }
        submitKeepingFields(save)(event);
      }}
      className="flex flex-col gap-[var(--yk-space-6)]">
      <input type="hidden" name="mailingId" value={props.mailingId} />
      <input type="hidden" name="filter" value={props.filterJson} />
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="testPersonId" value={testPersonId} />

      <Field label="Текст" hint="Ссылки пишите прямо в тексте — мессенджер сделает их кликабельными." required>
        <Textarea
          ref={textInput}
          name="text"
          rows={6}
          required
          defaultValue={props.text}
          error={textError ?? undefined}
          onChange={() => textError && setTextError(null)}
        />
      </Field>

      <Field label="Картинка" hint="Одна, PNG, JPG, GIF или WebP до 10 МБ. Можно без картинки.">
        <div className="flex flex-col gap-2">
          {props.imageName ? (
            <Checkbox name="removeImage" checked={removeImage} onCheckedChange={setRemoveImage}>Убрать прикреплённую картинку ({props.imageName})</Checkbox>
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
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Слишком большую сервер не примет: выбор сбрасывается сразу, набранный текст остаётся
                const tooLarge = isFileTooLarge(file, IMAGE_MAX_BYTES);
                if (tooLarge) event.target.value = "";
                setImageError(tooLarge ? "Картинка больше 10 МБ — выберите поменьше" : null);
                const name = tooLarge ? null : (file?.name ?? null);
                setImageFile(name);
                if (name) setRemoveImage(false);
              }}
            />
            <Button type="button" variant="secondary" onClick={() => imageInput.current?.click()}>
              {imageFile ? "Выбрать другую" : "Выбрать картинку"}
            </Button>
            <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{imageFile ?? "Файл не выбран"}</span>
          </div>
          {imageError ? <p role="alert" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">{imageError}</p> : null}
        </div>
      </Field>

      <div className="flex flex-wrap items-end gap-[var(--yk-space-4)]">
        <Field label="Кому прислать пробу" hint="Выберите себя: вы есть среди людей, если писали своему боту.">
          <TestRecipientPicker options={options} selected={tester} onSearch={setSearch} onSelect={setTester} />
        </Field>
        <Button type="submit" name="intent" value="test" variant="secondary" disabled={pending}>
          Отправить себе
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-[var(--yk-space-4)]">
        <Field label="Время по Москве" hint="Для отложенной отправки.">
          <Input
            type="datetime-local"
            name="at"
            aria-label="Время по Москве"
            className="w-60"
            // Enter во времени — «Запланировать», а не первая кнопка формы («Отправить себе»)
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (scheduleButton.current && !scheduleButton.current.disabled) event.currentTarget.form?.requestSubmit(scheduleButton.current);
            }}
          />
        </Field>
        <Button ref={scheduleButton} type="submit" name="intent" value="schedule" variant="secondary" disabled={pending || !filterApplied}>
          Запланировать
        </Button>
      </div>

      {filterApplied ? null : (
        <Alert
          variant="warm"
          title={
            props.recipientFilterBroken
              ? "Фильтр в «Кому» испорчен: выберите получателей заново и нажмите «Показать»"
              : "Выбор в «Кому» ещё не применён: нажмите «Показать», чтобы проверить получателей"
          }
        />
      )}
      {state.error ? <Alert variant="danger" title={state.error} /> : null}

      <div className="flex flex-wrap items-center gap-[var(--yk-space-4)]">
        <span className="basis-full font-semibold" data-testid="recipients-phrase">
          {recipientsPhrase(props.recipientCount)}
        </span>
        <Button type="submit" name="intent" value="now" disabled={pending || !filterApplied || props.recipientCount === 0}>
          Отправить сейчас
        </Button>
        <Button type="submit" name="intent" value="save" variant="ghost" disabled={pending || !filterApplied}>
          Сохранить черновик
        </Button>
      </div>
    </form>
  );
}
