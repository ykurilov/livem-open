"use client";

import { useActionState, useState } from "react";
import {
  Alert,
  Button,
  Input,
} from "@/ui/primitives";
import { Dialog } from "@ykurilov/ds-react";
import { CheckIcon as Check, TrashIcon as Trash2 } from "@phosphor-icons/react";
import { IconButton } from "@/ui/icon-button";
import { deleteFieldAction, renameFieldAction, type FieldActionState } from "./actions";

/** Переименовать и удалить поле словаря. */
export function FieldActions({ field }: { field: { id: string; name: string } }) {
  const [renameState, rename, renaming] = useActionState<FieldActionState, FormData>(renameFieldAction.bind(null, field.id), {});
  const [deleteState, remove, deleting] = useActionState<FieldActionState>(deleteFieldAction.bind(null, field.id), {});
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="flex flex-col items-end gap-2">
      {/* На телефоне поле ввода сжимается, чтобы галочка и корзина остались с ним в одной строке */}
      <div className="flex w-full items-center justify-end gap-2">
        <form action={rename} className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <Input
            name="name"
            aria-label={`Новое имя поля «${field.name}»`}
            defaultValue={field.name}
            className="min-w-0 flex-1 sm:w-56 sm:flex-none"
          />
          <IconButton
            type="submit"
            variant="secondary"
            label={`Переименовать поле «${field.name}»`}
            icon={Check}
            loading={renaming}
          />
        </form>
        <IconButton label={`Удалить поле «${field.name}»`} icon={Trash2} onClick={() => setConfirmOpen(true)} />
        <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title={`Удалить поле «${field.name}»?`}>

              <p className="app-muted mb-4">Поле пропадёт из словаря и из карточек.</p>

            <div>
              Уже записанные значения не потеряются: они перейдут в свободные факты людей, например «{field.name}: да».
            </div>
            <div className="app-dialog-actions">

                <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)}>
                  Отмена
                </Button>

              <form action={remove}>
                <Button type="submit" variant="destructive" loading={deleting}>
                  Удалить поле
                </Button>
              </form>
            </div>

        </Dialog>
      </div>
      {renameState.error ? <Alert variant="danger" title={renameState.error} /> : null}
      {deleteState.error ? <Alert variant="danger" title={deleteState.error} /> : null}
    </div>
  );
}
