"use client";

import type { ModelMenu } from "@ykurilov/agent-chat-core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Alert, Button, Field, Input, Textarea } from "@/ui/primitives";
import type { LeadMagnetSettings } from "@/modules/lead-magnets";
import { Select } from "@/ui";
import { Checkbox } from "@/ui/checkbox";
import { saveSettingsAction } from "../actions";

type TextKey = "name" | "endCondition" | "farewellMessage";

// Описание карточки правится в самой карточке на главной странице
const textFields: Array<{ key: TextKey; label: string; rows?: number }> = [
  { key: "name", label: "Название" },
  { key: "endCondition", label: "Условие завершения", rows: 2 },
  { key: "farewellMessage", label: "Прощальное сообщение", rows: 2 },
];

const DEFAULT_REASONING = "default";

/** Меню моделей — то же, что отдаёт SDK конструктора. */
function useModelMenu(): ModelMenu | null {
  const [menu, setMenu] = useState<ModelMenu | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/constructor/models")
      .then((response) => (response.ok ? (response.json() as Promise<ModelMenu>) : null))
      .then((loaded) => !cancelled && setMenu(loaded))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return menu;
}

/** Ролик архива, который можно разрешить консультанту. */
export interface ArchiveVideo {
  id: string;
  title: string;
  description: string;
}

/** Картинка архива, которую можно разрешить консультанту. */
export interface ArchiveImage {
  id: string;
  title: string;
  description: string;
}

export interface SettingsTabProps {
  leadMagnetId: string;
  draft: LeadMagnetSettings;
  /** Версия, с которой открыта форма: если черновик уже другой, сохранение ляжет поверх с предупреждением. */
  draftVersionId: string;
  videos: ArchiveVideo[];
  images: ArchiveImage[];
  /** Черновик правит конструктор — форма закрыта. */
  locked: boolean;
  /** Почему сохранение сейчас закрыто (на доске есть несохранённая правка); `null` — открыто. */
  saveBlockedBecause: string | null;
  /** Есть несохранённая правка — пока она есть, конструктору писать нельзя. */
  onDirtyChange(dirty: boolean): void;
  /**
   * Эта версия черновика сохранена из формы. Форма пересоздаётся с каждой новой версией, поэтому «Сохранено» помнит
   * редактор, а не сама форма: иначе надпись пропадает вместе с прежней формой.
   */
  justSaved: boolean;
  /** Правка сохранена новой версией `versionId`; `overwroteNewerDraft` — черновик успел измениться, и правка легла поверх. */
  onSaved(result: { versionId: string; overwroteNewerDraft: boolean }): void;
}

export function SettingsTab({ leadMagnetId, draft, draftVersionId, videos, images, locked, saveBlockedBecause, justSaved, onDirtyChange, onSaved }: SettingsTabProps) {
  const router = useRouter();
  const menu = useModelMenu();
  const [settings, setSettings] = useState(draft);
  const dirty = JSON.stringify(settings) !== JSON.stringify(draft);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  // Форма уходит (новая версия черновика) — правки в ней больше нет
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(justSaved);
  const [saving, startSaving] = useTransition();

  const update = (patch: Partial<LeadMagnetSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    setSaved(false);
  };
  // Основная инструкция — «Общее для всех состояний» сценария: её видно и на доске
  const updateCommon = (common: string) => update({ flow: { ...settings.flow, common } });

  const provider = menu?.providers.find((p) => p.id === settings.providerId);
  const model = provider?.models.find((m) => m.id === settings.modelId);

  const save = () =>
    startSaving(async () => {
      const result = await saveSettingsAction(leadMagnetId, settings, draftVersionId);
      if (!result.ok) return setError(result.error);
      setError(null);
      setSaved(true);
      onSaved(result);
      router.refresh();
    });

  return (
    <form
      className="flex flex-col gap-[var(--yk-space-4)] pb-6"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <fieldset disabled={locked || saving} className="contents">
      <Field label="Основная инструкция" hint="Кто агент, как говорит, что можно и нельзя. Действует на всех этапах.">
        <Textarea rows={10} value={settings.flow.common} onChange={(event) => updateCommon(event.target.value)} />
      </Field>
      <Field label="Чем агент начинает разговор (обязательно)" hint="Без него бот молчит, пока человек не напишет сам.">
        <Textarea rows={3} value={settings.firstMessage} onChange={(event) => update({ firstMessage: event.target.value })} />
      </Field>
      {textFields.map(({ key, label, rows }) => (
        <Field key={key} label={label}>
          {rows ? (
            <Textarea rows={rows} value={settings[key]} onChange={(event) => update({ [key]: event.target.value })} />
          ) : (
            <Input value={settings[key]} onChange={(event) => update({ [key]: event.target.value })} />
          )}
        </Field>
      ))}

      {/* Если у сценария есть «Дни и время», разговор ограничивают рамки дня, а не общий предел */}
      {settings.flow.schedule ? null : (
        <Field label="Предел сообщений человека">
          <Input
            type="number"
            min={1}
            value={settings.maxPersonMessages}
            onChange={(event) => update({ maxPersonMessages: Number(event.target.value) })}
          />
        </Field>
      )}

      <fieldset className="flex flex-wrap gap-2">
        <legend className="mb-1 text-[length:var(--yk-text-small-size)] font-semibold">Модель консультанта</legend>
        <Select
          aria-label="Провайдер"
          value={settings.providerId}
          options={(menu?.providers ?? []).map((p) => ({ value: p.id, label: p.displayName }))}
          onValueChange={(providerId) => {
            const first = menu?.providers.find((p) => p.id === providerId)?.models[0];
            update({ providerId, modelId: first?.id ?? settings.modelId, reasoning: null });
          }}
        />
        <Select
          aria-label="Модель"
          value={settings.modelId}
          options={(provider?.models ?? []).map((m) => ({ value: m.id, label: m.displayName }))}
          onValueChange={(modelId) => update({ modelId, reasoning: null })}
        />
        {model?.reasoning ? (
          <Select
            aria-label="Уровень рассуждения"
            value={settings.reasoning ?? DEFAULT_REASONING}
            options={[
              { value: DEFAULT_REASONING, label: "По умолчанию" },
              ...model.reasoning.levels.map((level) => ({ value: level, label: level })),
            ]}
            onValueChange={(reasoning) => update({ reasoning: reasoning === DEFAULT_REASONING ? null : reasoning })}
          />
        ) : null}
      </fieldset>

      <Alert variant="info" title="Этапы, дни и касания — на вкладке «Сценарий»">
        Там же карточка клиента, попутные задачи и ссылки, которые смотрит агент.
      </Alert>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-[length:var(--yk-text-small-size)] font-semibold">Видео, которые консультант может присылать</legend>
        {videos.length === 0 ? (
          <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
            Архив видео пока пуст. Ролики добавляются в разделе <Link href="/videos" className="app-focus underline">«Видео»</Link>.
          </p>
        ) : null}
        {videos.map((video) => (
          <Checkbox key={video.id}
              checked={settings.videoIds.includes(video.id)}
              onCheckedChange={(checked) =>
                update({
                  videoIds: checked === true ? [...settings.videoIds, video.id] : settings.videoIds.filter((id) => id !== video.id),
                })
              }
            >
              {video.title} <span className="text-[var(--yk-muted)]">- {video.description}</span>
            </Checkbox>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-[length:var(--yk-text-small-size)] font-semibold">Картинки, которые консультант может показывать</legend>
        {images.length === 0 ? (
          <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
            Архив картинок пока пуст. Картинки добавляются в разделе <Link href="/images" className="app-focus underline">«Картинки»</Link>.
          </p>
        ) : null}
        {images.map((image) => (
          <Checkbox
            key={image.id}
            checked={settings.imageIds.includes(image.id)}
            onCheckedChange={(checked) =>
              update({
                imageIds: checked === true ? [...settings.imageIds, image.id] : settings.imageIds.filter((id) => id !== image.id),
              })
            }
          >
            {image.title} <span className="text-[var(--yk-muted)]">- {image.description}</span>
          </Checkbox>
        ))}
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" loading={saving} disabled={!dirty || saveBlockedBecause !== null}>
          Сохранить
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!dirty}
          onClick={() => {
            setSettings(draft);
            setError(null);
          }}
        >
          Отменить
        </Button>
        {saved ? <span role="status" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">Сохранено</span> : null}
        {saveBlockedBecause && dirty ? <span role="status" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{saveBlockedBecause}</span> : null}
        {error ? <span role="alert" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">{error}</span> : null}
      </div>
      </fieldset>
    </form>
  );
}
