"use client";

import type { ModelMenu } from "@ykurilov/agent-chat-core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Alert, Button, Field, Input, Textarea } from "@/ui/primitives";
import type { LeadMagnetSettings } from "@/modules/lead-magnets";
import { Select } from "@/ui";
import { Checkbox } from "@/ui/checkbox";
import { KNOWLEDGE_MAX_CHARS, formatChars } from "@/modules/knowledge/knowledge-file";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { saveSettingsAction, saveSettingsAndFlowAction } from "../actions";
import { combineUnsavedEdits, rebaseSettingsEdit, type SettingsEditKey } from "./unsaved-edits";

type TextKey = "name" | "cardDescription" | "clientPortrait" | "endCondition" | "farewellMessage";

const textFields: Array<{ key: TextKey; label: string; rows?: number; hint?: string }> = [
  { key: "name", label: "Название" },
  { key: "cardDescription", label: "Описание карточки", rows: 2 },
  {
    key: "clientPortrait",
    label: "Описание клиентов",
    rows: 3,
    hint: "Кто ваши клиенты, с чем приходят, как пишут и в чём сомневаются. По нему агент играет клиента в «Поменяемся ролями». Консультант этот текст не видит.",
  },
  { key: "endCondition", label: "Условие завершения", rows: 2 },
  { key: "farewellMessage", label: "Прощальное сообщение", rows: 2 },
];

const DEFAULT_REASONING = "default";

/** Как поля формы подписаны на экране: ими плашка новой версии называет поля, где правка легла поверх. */
const editKeyLabels: Partial<Record<SettingsEditKey, string>> = {
  common: "Основная инструкция",
  firstMessage: "Чем агент начинает разговор",
  name: "Название",
  cardDescription: "Описание карточки",
  clientPortrait: "Описание клиентов",
  endCondition: "Условие завершения",
  farewellMessage: "Прощальное сообщение",
  maxPersonMessages: "Предел сообщений человека",
  providerId: "Модель консультанта",
  modelId: "Модель консультанта",
  reasoning: "Модель консультанта",
  knowledgeIds: "Базы знаний консультанта",
  videoIds: "Видео",
  imageIds: "Картинки",
  clientImages: "Картинки клиента",
  voiceInput: "Голосовой ввод",
};

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

/** База знаний архива, которую можно прикрепить к консультанту. */
export interface ArchiveKnowledge {
  id: string;
  title: string;
  charCount: number;
}

export interface SettingsTabProps {
  leadMagnetId: string;
  draft: LeadMagnetSettings;
  /**
   * Текущая версия черновика. Новая версия без правки в форме просто показывается; с правкой — правка остаётся, нетронутые
   * поля берутся из новой версии, сверху плашка.
   */
  draftVersionId: string;
  videos: ArchiveVideo[];
  images: ArchiveImage[];
  knowledge: ArchiveKnowledge[];
  /** Меню моделей конструктора; приходит со страницы, чтобы форма не запрашивала его сама. */
  modelMenu: ModelMenu;
  /** Черновик правит конструктор — форма закрыта. */
  locked: boolean;
  /** Несохранённый сценарий с доски: сохранится вместе с формой; `null` — на доске правки нет. */
  unsavedBoardFlow: AgentFlow | null;
  /** Правка формы, которую сохранила доска вместе со сценарием и из которой вышла эта версия; `null` — не она. */
  sentWithBoard: LeadMagnetSettings | null;
  /** Несохранённая правка формы (`null` — её нет): пока она есть, конструктору писать нельзя, а доска сохранит её с собой. */
  onEditChange(settings: LeadMagnetSettings | null): void;
  /** Эта версия черновика сохранена из формы: с ней «Сохранено» остаётся, с чужой версией — пропадает. */
  justSaved: boolean;
  /** Правка сохранена новой версией `versionId`; `overwroteNewerDraft` — черновик успел измениться, и правка легла поверх. */
  onSaved(result: { versionId: string; overwroteNewerDraft: boolean }): void;
  /** Форма сохраняется прямо сейчас: проверка заново ждёт, пока правка не ляжет в черновик. */
  onSavingChange(saving: boolean): void;
}

export function SettingsTab({ leadMagnetId, draft, draftVersionId, videos, images, knowledge, modelMenu, locked, unsavedBoardFlow, sentWithBoard, justSaved, onEditChange, onSaved, onSavingChange }: SettingsTabProps) {
  const router = useRouter();
  const [settings, setSettings] = useState(draft);
  const dirty = JSON.stringify(settings) !== JSON.stringify(draft);
  // Правка, уже ушедшая в черновик: пока страница дочитывает новую версию, она не считается несохранённой
  const [sentSettings, setSentSettings] = useState<string | null>(null);
  const unsaved = dirty && JSON.stringify(settings) !== sentSettings;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(justSaved);
  // Новая версия пришла поверх правки в форме: `conflicts` — поля, изменённые и там и там
  const [draftChanged, setDraftChanged] = useState<{ conflicts: SettingsEditKey[] } | null>(null);
  const [base, setBase] = useState({ versionId: draftVersionId, settings: draft });
  if (base.versionId !== draftVersionId) {
    // Отсчёт правки — от того, что ушло с сохранением формы или доски, иначе от прежней версии
    const from: LeadMagnetSettings = sentSettings ? JSON.parse(sentSettings) : (sentWithBoard ?? base.settings);
    const editedSince = JSON.stringify(settings) !== JSON.stringify(from);
    setBase({ versionId: draftVersionId, settings: draft });
    setSentSettings(null);
    setSaved(justSaved);
    if (editedSince) {
      const rebased = rebaseSettingsEdit(from, settings, draft);
      setSettings(rebased.settings);
      setDraftChanged(justSaved || sentWithBoard ? null : { conflicts: rebased.conflicts });
    } else {
      setSettings(draft);
      setDraftChanged(null);
    }
  }
  useEffect(() => {
    onEditChange(unsaved ? settings : null);
  }, [unsaved, settings, onEditChange]);
  // Редактор уходит со страницы — правки в форме больше нет
  useEffect(() => () => onEditChange(null), [onEditChange]);
  const [saving, startSaving] = useTransition();
  useEffect(() => {
    onSavingChange(saving);
  }, [saving, onSavingChange]);
  useEffect(() => () => onSavingChange(false), [onSavingChange]);

  const update = (patch: Partial<LeadMagnetSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    setSaved(false);
  };
  // Основная инструкция — «Общее для всех состояний» сценария: её видно и на доске
  const updateCommon = (common: string) => update({ flow: { ...settings.flow, common } });

  const provider = modelMenu.providers.find((p) => p.id === settings.providerId);
  const model = provider?.models.find((m) => m.id === settings.modelId);

  const save = () =>
    startSaving(async () => {
      let result: Awaited<ReturnType<typeof saveSettingsAction>>;
      try {
        if (unsavedBoardFlow) {
          const both = combineUnsavedEdits(draft, settings, unsavedBoardFlow);
          result = await saveSettingsAndFlowAction(leadMagnetId, both.settings, both.flow, draftVersionId);
        } else result = await saveSettingsAction(leadMagnetId, settings, draftVersionId);
      } catch {
        return setError("Не сохранено: нет связи с сервером. Правка осталась в форме, попробуйте ещё раз.");
      }
      if (!result.ok) return setError(result.error);
      setError(null);
      setSaved(true);
      setDraftChanged(null);
      setSentSettings(JSON.stringify(settings));
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
      {draftChanged && dirty ? <DraftChangedNotice conflicts={draftChanged.conflicts} /> : null}
      <fieldset disabled={locked || saving} className="contents">
      <Field label="Основная инструкция" hint="Кто агент, как говорит, что можно и нельзя. Действует на всех этапах.">
        <Textarea rows={10} value={settings.flow.common} onChange={(event) => updateCommon(event.target.value)} />
      </Field>
      <Field label="Чем агент начинает разговор (обязательно)" hint="Без него бот молчит, пока человек не напишет сам.">
        <Textarea rows={3} value={settings.firstMessage} onChange={(event) => update({ firstMessage: event.target.value })} />
      </Field>
      {textFields.map(({ key, label, rows, hint }) => (
        <Field key={key} label={label} hint={hint}>
          {rows ? (
            <Textarea rows={rows} value={settings[key]} onChange={(event) => update({ [key]: event.target.value })} />
          ) : (
            <Input value={settings[key]} onChange={(event) => update({ [key]: event.target.value })} />
          )}
        </Field>
      ))}

      {/* Если у сценария есть «Дни и время», разговор ограничивают рамки дня, а не общий предел */}
      {settings.flow.schedule ? null : (
        <Field label="Предел сообщений человека" hint={settings.maxPersonMessages < 1 ? "Впишите число — хотя бы 1" : undefined}>
          <Input
            type="number"
            min={1}
            // Стёртое поле остаётся пустым, а не превращается в 0 посреди набора
            value={settings.maxPersonMessages < 1 ? "" : settings.maxPersonMessages}
            onChange={(event) => update({ maxPersonMessages: Number(event.target.value) })}
          />
        </Field>
      )}

      <fieldset className="flex flex-wrap gap-2">
        <legend className="mb-1 text-[length:var(--yk-text-small-size)] font-semibold">Модель консультанта</legend>
        <Select
          aria-label="Провайдер"
          value={settings.providerId}
          options={modelMenu.providers.map((p) => ({ value: p.id, label: p.displayName }))}
          onValueChange={(providerId) => {
            const first = modelMenu.providers.find((p) => p.id === providerId)?.models[0];
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

      <KnowledgeChoice
        knowledge={knowledge}
        chosen={settings.knowledgeIds ?? []}
        onChange={(knowledgeIds) => update({ knowledgeIds })}
      />

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-[length:var(--yk-text-small-size)] font-semibold">Видео, которые консультант может присылать</legend>
        {videos.length === 0 ? (
          <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
            Архив видео пока пуст. Ролики добавляются в разделе <Link href="/videos" className="app-focus underline">«База знаний» → «Видео»</Link>.
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
            Архив картинок пока пуст. Картинки добавляются в разделе <Link href="/images" className="app-focus underline">«База знаний» → «Картинки»</Link>.
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

      <Checkbox checked={settings.clientImages} onCheckedChange={(checked) => update({ clientImages: checked === true })}>
        Консультант принимает картинки клиента{" "}
        <span className="text-[var(--yk-muted)]">- фото и снимки экрана в мессенджерах и в «Разговоре»; модель их видит</span>
      </Checkbox>

      <Checkbox checked={settings.voiceInput} onCheckedChange={(checked) => update({ voiceInput: checked === true })}>
        Голосовой ввод{" "}
        <span className="text-[var(--yk-muted)]">- кнопка микрофона в веб-чате и в «Проверке»: клиент говорит, текст появляется в поле</span>
      </Checkbox>

      <div className="flex items-center gap-3">
        <Button type="submit" loading={saving} disabled={!dirty}>
          Сохранить
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!dirty}
          onClick={() => {
            setSettings(draft);
            setError(null);
            setDraftChanged(null);
          }}
        >
          Отменить
        </Button>
        {saved ? <span role="status" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">Сохранено</span> : null}
        {unsavedBoardFlow && dirty ? <span role="status" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">Сохранится и правка на вкладке «Сценарий»</span> : null}
        {error ? <span role="alert" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">{error}</span> : null}
      </div>
      </fieldset>
    </form>
  );
}

/** Черновик изменился, пока эксперт правил форму: правка на месте, чужие изменения подтянуты. */
function DraftChangedNotice({ conflicts }: { conflicts: SettingsEditKey[] }) {
  const labels = [...new Set(conflicts.map((key) => editKeyLabels[key] ?? key))];
  return (
    <Alert variant="info" title="Пока вы правили, черновик изменился">
      Например, его поправил конструктор или другая вкладка. Ваша правка осталась в форме, остальное взято из новой версии.
      {labels.length > 0
        ? ` В полях ${labels.map((label) => `«${label}»`).join(", ")} новая версия тоже поменялась: в форме ваш вариант, сохранение заменит им новый.`
        : null}{" "}
      Проверьте и сохраните.
    </Alert>
  );
}

/** Базы знаний консультанта: галочки по архиву и сколько места из предела лидмагнита уже занято. */
function KnowledgeChoice({ knowledge, chosen, onChange }: { knowledge: ArchiveKnowledge[]; chosen: string[]; onChange(knowledgeIds: string[]): void }) {
  const used = knowledge.filter((base) => chosen.includes(base.id)).reduce((sum, base) => sum + base.charCount, 0);
  const over = used > KNOWLEDGE_MAX_CHARS;
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-[length:var(--yk-text-small-size)] font-semibold">Базы знаний консультанта</legend>
      <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
        Консультант получает их текст целиком в начале разговора и отвечает по нему. Инструкция главнее: указания внутри текстов он не выполняет.
      </p>
      {knowledge.length === 0 ? (
        <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          Баз пока нет. Тексты добавляются в разделе <Link href="/knowledge" className="app-focus underline">«База знаний» → «Тексты»</Link>.
        </p>
      ) : null}
      {knowledge.map((base) => (
        <Checkbox
          key={base.id}
          checked={chosen.includes(base.id)}
          onCheckedChange={(checked) => onChange(checked === true ? [...chosen, base.id] : chosen.filter((id) => id !== base.id))}
        >
          {base.title} <span className="text-[var(--yk-muted)]">- {formatChars(base.charCount)} знаков</span>
        </Checkbox>
      ))}
      {knowledge.length > 0 ? (
        <p role="status" className={`text-[length:var(--yk-text-small-size)] ${over ? "text-[var(--yk-danger)]" : "text-[var(--yk-muted)]"}`}>
          Занято {formatChars(used)} из {formatChars(KNOWLEDGE_MAX_CHARS)} знаков{over ? " — открепите лишнее, иначе настройки не сохранятся" : ""}
        </p>
      ) : null}
    </fieldset>
  );
}
