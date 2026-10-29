"use client";

import { startTransition, useActionState, useEffect, useState, cloneElement, type ReactElement } from "react";
import {
  Alert,
  Button,
  Field,
  Input,
  Textarea,
} from "@/ui/primitives";
import { Dialog } from "@ykurilov/ds-react";
import { PencilSimpleIcon as Pencil, TrashIcon as Trash2 } from "@phosphor-icons/react";
import { IconButton } from "@/ui/icon-button";
import { timeLabel } from "@ykurilov/agent-chat-videos";
import type { Video } from "@/modules/videos";
import { deleteVideoAction, saveVideoAction, type VideoActionState } from "./actions";

/** Окно с формой ролика: новый (`video` нет) или правка. Сохранилось — окно закрывается. */
function VideoFormDialog({ video, trigger, title }: { video?: Video; trigger: ReactElement<{ onClick?: () => void }>; title: string }) {
  const [open, setOpen] = useState(false);
  const [state, save, saving] = useActionState<VideoActionState, FormData>(saveVideoAction.bind(null, video?.id ?? null), {});
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

            <p className="app-muted mb-4">Консультант находит ролик по названию, описанию и главам.</p>

          <div className="flex flex-col gap-[var(--yk-space-4)]">
            <Field label="Ссылка" hint="YouTube или Kinescope: https://youtu.be/… или https://kinescope.io/…" required>
              <Input name="url" defaultValue={video?.url} spellCheck={false} autoComplete="off" />
            </Field>
            <Field label="Название" required>
              <Input name="title" defaultValue={video?.title} />
            </Field>
            <Field label="О чём ролик" hint="Пара фраз: по ним консультант понимает, кому ролик поможет." required>
              <Textarea name="description" rows={3} defaultValue={video?.description} />
            </Field>
            <Field label="Длительность" hint="Необязательно. Например, 19:13.">
              <Input name="duration" defaultValue={video?.durationSeconds ? timeLabel(video.durationSeconds) : ""} className="w-32" />
            </Field>
            <Field label="Главы" hint="Необязательно. По строке: «3:20 Примеры».">
              <Textarea
                name="chapters"
                rows={3}
                defaultValue={video?.chapters.map((chapter) => `${timeLabel(chapter.startSeconds)} ${chapter.title}`).join("\n")}
              />
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

export function AddVideoButton() {
  return <VideoFormDialog title="Новый ролик" trigger={<Button type="button">Добавить ролик</Button>} />;
}

/** Изменить и удалить ролик архива. */
export function VideoActions({ video }: { video: Video }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteState, remove, deleting] = useActionState<VideoActionState>(deleteVideoAction.bind(null, video.id), {});
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <VideoFormDialog
          video={video}
          title={`Ролик «${video.title}»`}
          trigger={<IconButton variant="secondary" label={`Изменить ролик «${video.title}»`} icon={Pencil} />}
        />
        <IconButton label={`Удалить ролик «${video.title}»`} icon={Trash2} onClick={() => setConfirmOpen(true)} />
        <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title={`Удалить ролик «${video.title}»?`}>

              <p className="app-muted mb-4">Консультант перестанет его присылать во всех лидмагнитах.</p>

            <div>Уже присланные ссылки у людей останутся.</div>
            <div className="app-dialog-actions">

                <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)}>
                  Отмена
                </Button>

              <form action={remove}>
                <Button type="submit" variant="destructive" loading={deleting}>
                  Удалить ролик
                </Button>
              </form>
            </div>

        </Dialog>
      </div>
      {deleteState.error ? <Alert variant="danger" title={deleteState.error} /> : null}
    </div>
  );
}
