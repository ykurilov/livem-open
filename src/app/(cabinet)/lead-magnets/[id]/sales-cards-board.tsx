"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { FlowEditorSkin, FlowOverviewPanelProps, FlowStatePanelProps } from "@ykurilov/agent-chat-flows/react";
import { Dialog, Radio, RadioGroup } from "@ykurilov/ds-react";
import { PlusIcon as Plus } from "@phosphor-icons/react";
import { Alert, Badge, Button, Field, Input, Textarea } from "@/ui/primitives";
import { Select } from "@/ui";
import { salesCardLabels as labels } from "@/ui/flow-labels";
import {
  SALES_CARD_TEXT_MAX_LENGTH,
  SALES_CARD_TITLE_MAX_LENGTH,
  SALES_CARD_WHEN_MAX_LENGTH,
  type SalesCard,
  type SalesCardInput,
} from "@/modules/sales-cards/sales-cards";

type SaveResult = { ok: true; card: SalesCard } | { ok: false; error: string };

/** Что нужно разделам заготовок на доске: заготовки черновика, этапы и сохранение. */
export interface SalesCardsBoard {
  cards: readonly SalesCard[];
  states: ReadonlyArray<{ id: string; title: string }>;
  /** Конструктор правит черновик: заготовки только для просмотра. */
  locked: boolean;
  save(card: SalesCardInput): Promise<SaveResult>;
  remove(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

const SalesCardsContext = createContext<SalesCardsBoard | null>(null);
export const SalesCardsProvider = SalesCardsContext.Provider;

/** Окно открытой заготовки: правка (`id` есть) или новая. */
type Opened = SalesCardInput;

/**
 * Раздел заготовок в панели доски: заготовки этапа (`stateId`) или общая шпаргалка (`null`). Карточка открывается
 * окном, как остальные окна кабинета; сохраняется сразу, без кнопки «Сохранить» доски — это не часть сценария.
 */
function SalesCardsSection({ stateId }: { stateId: string | null }) {
  const board = useContext(SalesCardsContext);
  const [opened, setOpened] = useState<Opened | null>(null);
  if (!board) return null;
  const cards = board.cards.filter((card) => card.stateId === stateId);
  const title = stateId === null ? labels.commonTitle : labels.stageTitle;
  return (
    <section aria-label={title} data-sales-cards={stateId ?? "common"} className="flex flex-col gap-3 border-t border-[var(--yk-border)] pt-4">
      <h3 className="text-base font-semibold text-[var(--yk-text)]">{title}</h3>
      <p className="text-xs text-[var(--yk-muted)]">{stateId === null ? labels.commonHint : labels.stageHint}</p>
      {cards.length > 0 && (
        <ul className="flex flex-col gap-2">
          {cards.map((card) => (
            <li key={card.id}>
              <button
                type="button"
                data-sales-card={card.id}
                onClick={() => setOpened(card)}
                className="flex w-full min-w-0 flex-col gap-1 rounded-[var(--yk-radius-lg)] border border-[var(--yk-border)] bg-[var(--yk-surface)] p-3 text-left hover:border-[var(--yk-accent)] focus-visible:outline-2 focus-visible:outline-[var(--yk-accent)]"
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--yk-text)]">{card.title}</span>
                  {card.verbatim && <Badge variant="cool">{labels.verbatimBadge}</Badge>}
                </span>
                <span className="line-clamp-2 text-xs text-[var(--yk-muted)]">{card.when}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="secondary"
        size="sm"
        className="self-start"
        disabled={board.locked}
        onClick={() => setOpened({ stateId, title: "", when: "", text: "", verbatim: false })}
      >
        <Plus aria-hidden="true" className="size-3.5" />
        {labels.add}
      </Button>
      {opened && (
        <SalesCardDialog
          key={opened.id ?? "new"}
          initial={opened}
          states={board.states}
          locked={board.locked}
          onSave={board.save}
          onRemove={opened.id === undefined ? undefined : () => board.remove(opened.id!)}
          onClose={() => setOpened(null)}
        />
      )}
    </section>
  );
}

/**
 * Окно заготовки: название, «когда уместна», текст, как отправлять и где лежит. Его же открывает «Сохранить как
 * заготовку» у исправленного ответа — с текстом эксперта и подсказанными названием и поводом.
 */
export function SalesCardDialog({
  initial,
  states,
  locked = false,
  onSave,
  onRemove,
  onClose,
  hint,
}: {
  initial: SalesCardInput;
  states: ReadonlyArray<{ id: string; title: string }>;
  locked?: boolean;
  onSave(card: SalesCardInput): Promise<SaveResult>;
  onRemove?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onClose(): void;
  /** Строка над полями: откуда заготовка. */
  hint?: ReactNode;
}) {
  const [card, setCard] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const edit = (patch: Partial<SalesCardInput>) => setCard((current) => ({ ...current, ...patch }));
  const run = async (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.ok) onClose();
      else setError(result.error);
    } catch {
      setError(labels.offline);
    } finally {
      setBusy(false);
    }
  };
  const places = [{ value: "", label: labels.common }, ...states.map((state) => ({ value: state.id, label: state.title || state.id }))];
  return (
    <Dialog
      open
      onClose={onClose}
      closeOnBackdrop={false}
      title={initial.id === undefined ? labels.newTitle : labels.editTitle}
      actions={
        <>
          {onRemove && (
            <Button variant="destructive" disabled={locked || busy} onClick={() => run(onRemove)}>
              {labels.delete}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button disabled={locked || busy} onClick={() => run(() => onSave(card))}>
            {busy ? labels.saving : labels.save}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-[var(--yk-space-4)]"
        onSubmit={(event) => {
          event.preventDefault();
          if (!locked && !busy) void run(() => onSave(card));
        }}
      >
        {hint && <p className="app-muted">{hint}</p>}
        {locked && <Alert variant="info">{labels.locked}</Alert>}
        <Field label={labels.title} required>
          <Input value={card.title} maxLength={SALES_CARD_TITLE_MAX_LENGTH} disabled={locked} data-autofocus onChange={(event) => edit({ title: event.target.value })} />
        </Field>
        <Field label={labels.when} hint={labels.whenHint} required>
          <Textarea rows={2} value={card.when} maxLength={SALES_CARD_WHEN_MAX_LENGTH} disabled={locked} onChange={(event) => edit({ when: event.target.value })} />
        </Field>
        <Field label={labels.text} required>
          <Textarea rows={6} value={card.text} maxLength={SALES_CARD_TEXT_MAX_LENGTH} disabled={locked} onChange={(event) => edit({ text: event.target.value })} />
        </Field>
        <RadioGroup
          label={labels.mode}
          value={card.verbatim ? "verbatim" : "own"}
          onValueChange={(value) => edit({ verbatim: value === "verbatim" })}
          disabled={locked}
        >
          <Radio value="verbatim">
            {labels.verbatim} <span className="app-muted">— {labels.verbatimHint}</span>
          </Radio>
          <Radio value="own">
            {labels.ownWords} <span className="app-muted">— {labels.ownWordsHint}</span>
          </Radio>
        </RadioGroup>
        <Field label={labels.place}>
          <Select aria-label={labels.place} options={places} value={card.stateId ?? ""} disabled={locked} onValueChange={(value) => edit({ stateId: value || null })} />
        </Field>
        {error && <Alert variant="danger">{error}</Alert>}
      </form>
    </Dialog>
  );
}

/** Панель этапа: заготовки — после «Длится» и «Касаний», перед переходами. */
function StatePanelWithCards(Base: FlowEditorSkin["FlowStatePanel"]) {
  return function FlowStatePanel(props: FlowStatePanelProps) {
    return (
      <Base
        {...props}
        timing={
          <>
            {props.timing}
            <SalesCardsSection stateId={props.stateId} />
          </>
        }
      />
    );
  };
}

/** Обзор лидмагнита: общая шпаргалка — после «Дней и времени» и попутных задач. */
function OverviewWithCards(Base: FlowEditorSkin["FlowOverviewPanel"]) {
  return function FlowOverviewPanel(props: FlowOverviewPanelProps) {
    return (
      <Base
        {...props}
        sections={
          <>
            {props.sections}
            <SalesCardsSection stateId={null} />
          </>
        }
      />
    );
  };
}

/** Скин доски с разделами заготовок; сами заготовки — из `SalesCardsProvider`. */
export function withSalesCards(skin: FlowEditorSkin): FlowEditorSkin {
  return { ...skin, FlowStatePanel: StatePanelWithCards(skin.FlowStatePanel), FlowOverviewPanel: OverviewWithCards(skin.FlowOverviewPanel) };
}
