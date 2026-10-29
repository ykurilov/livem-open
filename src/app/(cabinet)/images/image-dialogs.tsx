"use client";

import { startTransition, useActionState, useEffect, useRef, useState, cloneElement, type ReactElement } from "react";
import { Alert, Button, Field, Input, Textarea } from "@/ui/primitives";
import { Dialog } from "@ykurilov/ds-react";
import { PencilSimpleIcon as Pencil, TrashIcon as Trash2 } from "@phosphor-icons/react";
import { IconButton } from "@/ui/icon-button";
import type { ExpertImage } from "@/modules/images";
import { deleteImageAction, saveImageAction, type ImageActionState } from "./actions";

/** Окно с формой картинки: новая (`image` нет) или правка. Сохранилось — окно закрывается. */
function ImageFormDialog({ image, trigger, title }: { image?: ExpertImage; trigger: ReactElement<{ onClick?: () => void }>; title: string }) {
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [state, save, saving] = useActionState<ImageActionState, FormData>(saveImageAction.bind(null, image?.id ?? null), {});
  useEffect(() => {
    if (state.done) setOpen(false);
  }, [state]);

  return (
    <>
      {cloneElement(trigger, { onClick: () => setOpen(true) })}
      <Dialog open={open} onClose={() => setOpen(false)} title={title}>
        {/* Не `action={save}`: после него React очищает поля, и при ошибке эксперт потерял бы всё набранное */}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            startTransition(() => save(formData));
          }}
        >
          <p className="app-muted mb-4">Консультант находит картинку по названию и описанию и показывает, когда она поможет человеку.</p>

          <div className="flex flex-col gap-[var(--yk-space-4)]">
            <Field label="Файл" hint={image ? "PNG, JPG, GIF или WebP до 10 МБ. Не выбран — останется прежняя картинка." : "PNG, JPG, GIF или WebP до 10 МБ."} required={!image}>
              <div className="flex items-center gap-[var(--yk-space-4)]">
                {/* Системный выбор файла спрятан: его подписи на языке браузера, а нужна кнопка в стиле кабинета */}
                <input
                  ref={fileInput}
                  type="file"
                  name="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  aria-label="Файл картинки"
                  className="sr-only"
                  tabIndex={-1}
                  onChange={(event) => setFileName(event.target.files?.[0]?.name ?? null)}
                />
                <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()}>
                  {fileName || image ? "Выбрать другую" : "Выбрать картинку"}
                </Button>
                <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{fileName ?? (image ? "Прежняя картинка" : "Файл не выбран")}</span>
              </div>
            </Field>
            <Field label="Название" required>
              <Input name="title" defaultValue={image?.title} />
            </Field>
            <Field label="Когда показывать" hint="Что на картинке и в какой момент она поможет человеку: по этому описанию консультант её находит." required>
              <Textarea name="description" rows={3} defaultValue={image?.description} />
            </Field>
            {state.error ? <Alert variant="danger" title={state.error} /> : null}
          </div>
          <div className="app-dialog-actions">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" loading={saving}>
              Сохранить
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function AddImageButton() {
  return <ImageFormDialog title="Новая картинка" trigger={<Button type="button">Добавить картинку</Button>} />;
}

/** Изменить и удалить картинку архива. */
export function ImageActions({ image }: { image: ExpertImage }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteState, remove, deleting] = useActionState<ImageActionState>(deleteImageAction.bind(null, image.id), {});
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ImageFormDialog
          image={image}
          title={`Картинка «${image.title}»`}
          trigger={<IconButton variant="secondary" label={`Изменить картинку «${image.title}»`} icon={Pencil} />}
        />
        <IconButton label={`Удалить картинку «${image.title}»`} icon={Trash2} onClick={() => setConfirmOpen(true)} />
        <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title={`Удалить картинку «${image.title}»?`}>
          <p className="app-muted mb-4">Консультант перестанет её показывать во всех лидмагнитах.</p>
          <div>Уже присланные картинки у людей останутся.</div>
          <div className="app-dialog-actions">
            <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)}>
              Отмена
            </Button>
            <form action={remove}>
              <Button type="submit" variant="destructive" loading={deleting}>
                Удалить картинку
              </Button>
            </form>
          </div>
        </Dialog>
      </div>
      {deleteState.error ? <Alert variant="danger" title={deleteState.error} /> : null}
    </div>
  );
}
