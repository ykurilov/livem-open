"use client";

import { startTransition, useActionState, useEffect, useRef, useState, cloneElement, type ReactElement } from "react";
import { Alert, Button, Field, Input } from "@/ui/primitives";
import { Dialog } from "@ykurilov/ds-react";
import { PencilSimpleIcon as Pencil, TrashIcon as Trash2 } from "@phosphor-icons/react";
import { IconButton } from "@/ui/icon-button";
import { isFileTooLarge, keepingFormOnSendFailure } from "@/ui/form-upload";
import { KNOWLEDGE_FILE_MAX_BYTES } from "@/modules/knowledge/knowledge-file";
import type { KnowledgeBaseListItem } from "@/modules/knowledge";
import { deleteKnowledgeAction, saveKnowledgeAction, type KnowledgeActionState } from "./actions";

const FILE_HINT = "Текст .txt или .md до 1 МБ.";

/** Окно с формой базы: новая (`base` нет) или правка. Сохранилось — окно закрывается. */
function KnowledgeFormDialog({ base, trigger, title }: { base?: KnowledgeBaseListItem; trigger: ReactElement<{ onClick?: () => void }>; title: string }) {
  const [open, setOpen] = useState(false);
  // Каждое открытие — новая форма: прошлый файл и прошлая ошибка не остаются
  const [opening, setOpening] = useState(0);
  return (
    <>
      {cloneElement(trigger, {
        onClick: () => {
          setOpening((count) => count + 1);
          setOpen(true);
        },
      })}
      <Dialog open={open} onClose={() => setOpen(false)} title={title}>
        <KnowledgeForm key={opening} base={base} onClose={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

function KnowledgeForm({ base, onClose }: { base?: KnowledgeBaseListItem; onClose(): void }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [state, save, saving] = useActionState<KnowledgeActionState, FormData>(keepingFormOnSendFailure(saveKnowledgeAction.bind(null, base?.id ?? null)), {});
  useEffect(() => {
    if (state.done) onClose();
  }, [state, onClose]);

  return (
    <>
      {/* Не `action={save}`: после него React очищает поля, и при ошибке эксперт потерял бы всё набранное */}
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          startTransition(() => save(formData));
        }}
      >
        <p className="app-muted mb-4">
          Консультант получает текст целиком и отвечает по нему. Указания внутри текста он не выполняет: правила разговора задаёт инструкция.
        </p>

        <div className="flex flex-col gap-[var(--yk-space-4)]">
          <Field
            label="Файл"
            hint={base ? `${FILE_HINT} Не выбран — останется прежний текст. Новый текст сразу получат все лидмагниты с этой базой.` : FILE_HINT}
            required={!base}
          >
            <div className="flex items-center gap-[var(--yk-space-4)]">
              {/* Системный выбор файла спрятан: его подписи на языке браузера, а нужна кнопка в стиле кабинета */}
              <input
                ref={fileInput}
                type="file"
                name="file"
                accept=".txt,.md,.markdown,text/plain,text/markdown"
                aria-label="Текстовый файл"
                className="sr-only"
                tabIndex={-1}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // Слишком большой сервер не примет: выбор сбрасывается сразу, набранное остаётся
                  const tooLarge = isFileTooLarge(file, KNOWLEDGE_FILE_MAX_BYTES);
                  if (tooLarge) event.target.value = "";
                  setFileError(tooLarge ? "Файл больше 1 МБ — разделите его на несколько" : null);
                  setFileName(tooLarge ? null : (file?.name ?? null));
                }}
              />
              <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()}>
                {fileName || base ? "Выбрать другой" : "Выбрать файл"}
              </Button>
              <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{fileName ?? (base ? base.fileName : "Файл не выбран")}</span>
            </div>
            {fileError ? <p role="alert" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">{fileError}</p> : null}
          </Field>
          <Field label="Название" hint={base ? undefined : "Не заполнено — возьмём имя файла."} required={Boolean(base)}>
            <Input name="title" defaultValue={base?.title} />
          </Field>
          {state.error ? <Alert variant="danger" title={state.error} /> : null}
        </div>
        <div className="app-dialog-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" loading={saving}>
            Сохранить
          </Button>
        </div>
      </form>
    </>
  );
}

export function AddKnowledgeButton() {
  return <KnowledgeFormDialog title="Новая база знаний" trigger={<Button type="button">Добавить текст</Button>} />;
}

/** Изменить (название, новый файл) и удалить базу знаний. */
export function KnowledgeActions({ base }: { base: KnowledgeBaseListItem }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteState, remove, deleting] = useActionState<KnowledgeActionState>(deleteKnowledgeAction.bind(null, base.id), {});
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <KnowledgeFormDialog
          base={base}
          title={`База знаний «${base.title}»`}
          trigger={<IconButton variant="secondary" label={`Изменить базу «${base.title}»`} icon={Pencil} />}
        />
        <IconButton label={`Удалить базу «${base.title}»`} icon={Trash2} onClick={() => setConfirmOpen(true)} />
        <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title={`Удалить базу «${base.title}»?`}>
          {base.usedBy.length > 0 ? (
            <>
              <p className="mb-2">
                {base.usedBy.length === 1 ? "База прикреплена к лидмагниту" : "База прикреплена к лидмагнитам"}{" "}
                {base.usedBy.map((lead) => `«${lead.name}»`).join(", ")}.
              </p>
              <p className="app-muted">Их консультанты сразу перестанут её получать — и в живых разговорах, и в «Проверке». Вернуть базу будет нельзя.</p>
            </>
          ) : (
            <p className="app-muted">База ни к одному лидмагниту не прикреплена. Вернуть её будет нельзя.</p>
          )}
          <div className="app-dialog-actions">
            <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)}>
              Отмена
            </Button>
            <form action={remove}>
              <Button type="submit" variant="destructive" loading={deleting}>
                Удалить базу
              </Button>
            </form>
          </div>
        </Dialog>
      </div>
      {deleteState.error ? <Alert variant="danger" title={deleteState.error} /> : null}
    </div>
  );
}
