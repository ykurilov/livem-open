"use client";

import { AgentChat, type AnswerEditorFields, type AnswerTextEditing, type MessageAction } from "@ykurilov/agent-chat-react";
import { ArrowCounterClockwiseIcon, CardsIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Field, Textarea } from "@/ui/primitives";
import { salesCardLabels } from "@/ui/flow-labels";
import type { SalesCardInput } from "@/modules/sales-cards/sales-cards";
import { salesCardFromCorrectionAction, saveSalesCardAction } from "../actions";
import { SalesCardDialog } from "./sales-cards-board";

/** Исправленный ответ ленты: `GET <api>/:chatId/corrections` (`/api/preview`, `/api/role-swap`). */
interface EditedAnswer {
  messageId: string;
  correctionId: string;
  pending: boolean;
}

type AgentChatProps = ComponentProps<typeof AgentChat>;
type FeedChange = Parameters<NonNullable<AgentChatProps["onFeedChange"]>>[0];

const EDITED_MARK = { textEdited: true, editedToolCallIds: [] as string[] };
const REASON_MAX_CHARS = 2000;

const correctionsUrl = (api: string, chatId: string) => `${api}/${encodeURIComponent(chatId)}/corrections`;

function ReasonField({ data, setData, disabled }: AnswerEditorFields) {
  return (
    <Field label="Почему так лучше" hint="Необязательно. Конструктор учтёт это, когда будет править правила.">
      <Textarea
        rows={2}
        maxLength={REASON_MAX_CHARS}
        disabled={disabled}
        value={typeof data.reason === "string" ? data.reason : ""}
        onChange={(event) => setData({ ...data, reason: event.target.value })}
      />
    </Field>
  );
}
const renderReasonField = (fields: AnswerEditorFields) => <ReasonField {...fields} />;

type CorrectablePreviewChatProps = AgentChatProps & {
  api: string;
  chatId: string;
  /** Правок стало больше или меньше: счёт «Разобрать правки (N)» читается заново. */
  onCorrectionsChanged(): void;
  /** «Сохранить как заготовку» у исправленных ответов консультанта; нет — действия нет («Поменяемся ролями»). */
  salesCards?: {
    leadMagnetId: string;
    states: ReadonlyArray<{ id: string; title: string }>;
    locked: boolean;
    /** Заготовка сохранена новой версией черновика. */
    onSaved(): void;
  };
};

/**
 * Чат «Проверки» с «Поправить»: окно правки модуля чата с полем «Почему так лучше», метка «Исправлено» у исправленных
 * ответов и «Убрать правку» у неразобранных.
 */
export function CorrectablePreviewChat({ onCorrectionsChanged, reloadKey, onFeedChange, salesCards, ...props }: CorrectablePreviewChatProps) {
  const { chatId, api } = props;
  const [edited, setEdited] = useState<EditedAnswer[]>([]);
  const [removals, setRemovals] = useState(0);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Заготовка из исправленного ответа, открытая в окне
  const [cardDraft, setCardDraft] = useState<SalesCardInput | null>(null);
  // Исправленные ответы, о которых метки уже спрошены: новая правка в ленте — повод перечитать метки и счёт
  const known = useRef(new Set<string>());

  const loadEdited = useCallback(async () => {
    const response = await fetch(correctionsUrl(api, chatId), { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { edited: EditedAnswer[] };
    for (const answer of body.edited) known.current.add(answer.messageId);
    setEdited(body.edited);
  }, [api, chatId]);

  useEffect(() => {
    loadEdited().catch(() => {});
  }, [loadEdited]);

  const watchFeed = useCallback(
    (feed: FeedChange) => {
      onFeedChange?.(feed);
      const fresh = feed.messages.filter((message) => message.metadata?.answerEdit && !known.current.has(message.id));
      if (fresh.length === 0) return;
      for (const message of fresh) known.current.add(message.id);
      // Правку записывает сервер, метки он же и сверяет с лентой: после ответа счёт уже верный
      loadEdited().then(onCorrectionsChanged, () => {});
    },
    [loadEdited, onCorrectionsChanged, onFeedChange],
  );

  const answerEditor = useMemo<AnswerTextEditing>(
    () => ({ renderFields: renderReasonField, edits: new Map(edited.map((answer) => [answer.messageId, EDITED_MARK])) }),
    [edited],
  );

  const messageActions = useMemo<MessageAction[]>(() => {
    const pending = new Map(edited.filter((answer) => answer.pending).map((answer) => [answer.messageId, answer.correctionId]));
    const corrections = new Map(edited.map((answer) => [answer.messageId, answer.correctionId]));
    const saveAsCard: MessageAction[] = salesCards
      ? [
          {
            id: "save-as-sales-card",
            label: salesCardLabels.saveFromCorrection,
            icon: <CardsIcon aria-hidden />,
            visible: ({ message }) => corrections.has(message.id),
            // Пока модель подсказывает название и повод, модуль чата держит кнопку занятой
            onRun: async ({ messageId }) => {
              const correctionId = corrections.get(messageId);
              if (!correctionId) return;
              setRemoveError(null);
              try {
                const result = await salesCardFromCorrectionAction(salesCards.leadMagnetId, correctionId);
                if ("card" in result) setCardDraft(result.card);
                else setRemoveError(result.error);
              } catch {
                setRemoveError("Нет связи — заготовка не подготовлена. Попробуйте ещё раз.");
              }
            },
          },
        ]
      : [];
    return [
      ...saveAsCard,
      {
        id: "remove-correction",
        label: "Убрать правку",
        icon: <ArrowCounterClockwiseIcon aria-hidden />,
        visible: ({ message }) => pending.has(message.id),
        // Пока запрос идёт, модуль чата держит кнопку занятой
        onRun: async ({ messageId }) => {
          const correctionId = pending.get(messageId);
          if (!correctionId) return;
          setRemoveError(null);
          let response: Response;
          try {
            response = await fetch(`${correctionsUrl(api, chatId)}/${encodeURIComponent(correctionId)}`, { method: "DELETE" });
          } catch {
            setRemoveError("Нет связи — правка не убрана. Попробуйте ещё раз.");
            return;
          }
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
            setRemoveError(body?.error?.message ?? "Правка не убрана. Обновите страницу и попробуйте ещё раз.");
            await loadEdited().catch(() => {});
            return;
          }
          await loadEdited().catch(() => {});
          setRemovals((count) => count + 1);
          onCorrectionsChanged();
        },
      },
    ];
  }, [api, chatId, edited, loadEdited, onCorrectionsChanged, salesCards]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {removeError ? (
        <p role="alert" className="px-3 py-1 text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">
          {removeError}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <AgentChat
          {...props}
          reloadKey={(reloadKey ?? 0) + removals}
          answerEditor={answerEditor}
          messageActions={messageActions}
          onFeedChange={watchFeed}
        />
      </div>
      {salesCards && cardDraft ? (
        <SalesCardDialog
          initial={cardDraft}
          states={salesCards.states}
          locked={salesCards.locked}
          hint={salesCardLabels.fromCorrectionHint}
          onSave={async (card) => {
            const result = await saveSalesCardAction(salesCards.leadMagnetId, card);
            if (result.ok) salesCards.onSaved();
            return result;
          }}
          onClose={() => setCardDraft(null)}
        />
      ) : null}
    </div>
  );
}
