"use client";

import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { PageHeader } from "@/ui";
import { Button, Field, Input } from "@/ui/primitives";
import { createLeadMagnetAction } from "./lead-magnets/actions";

/**
 * Шапка «Лидмагниты» с кнопкой «Новый лидмагнит»: форма создания раскрывается по нажатию и не отодвигает список вниз.
 * Пока лидмагнитов нет, форма открыта сразу — это единственное, что можно сделать на странице.
 * `requestId` станет id лидмагнита: повторное нажатие той же формы не создаст вторую карточку.
 */
export function LeadMagnetsHeaderWithCreate(props: { requestId: string; startOpen: boolean }) {
  // Первый ключ — на всё открытие страницы: она перерисовывается (публикация карточки), а повтор не должен завести вторую
  const [requestId] = useState(props.requestId);
  const [open, setOpen] = useState(props.startOpen);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <PageHeader
        title="Лидмагниты"
        action={
          open ? null : (
            <Button onClick={() => setOpen(true)}>
              <PlusIcon aria-hidden /> Новый лидмагнит
            </Button>
          )
        }
      />
      {open ? (
        <form
          action={createLeadMagnetAction}
          noValidate
          onSubmit={(event) => {
            if (nameRef.current?.value.trim()) return;
            event.preventDefault();
            setNameError("Напишите название лидмагнита");
            nameRef.current?.focus();
          }}
          className="mb-[var(--yk-space-8)] flex flex-wrap items-start gap-[var(--yk-space-4)]"
        >
          <input type="hidden" name="requestId" value={requestId} />
          <Field label="Название" className="w-full sm:w-80">
            <Input
              ref={nameRef}
              name="name"
              autoFocus={!props.startOpen}
              placeholder="Например, разбор воронки"
              error={nameError ?? undefined}
              onChange={() => nameError && setNameError(null)}
            />
          </Field>
          <Field label="Описание" className="w-full sm:w-80">
            <Input name="cardDescription" placeholder="Коротко для карточки" />
          </Field>
          {/* Кнопки на одной высоте с полями: отступ под подпись поля */}
          <div className="flex gap-[var(--yk-space-2)] sm:mt-[1.6rem]">
            <CreateButton />
            {props.startOpen ? null : (
              <Button
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                  setNameError(null);
                }}
              >
                <XIcon aria-hidden /> Отмена
              </Button>
            )}
          </div>
        </form>
      ) : null}
    </>
  );
}

function CreateButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending}>
      {pending ? "Создаю…" : "Создать"}
    </Button>
  );
}
