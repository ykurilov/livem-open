"use client";

import { chatLabelsWithToolTitles } from "@/modules/agent-log/tool-titles";
import { ChatLabelsProvider, russianLabels, type ChatSkin, type ComposerHelper } from "@ykurilov/agent-chat-react";
import { oduvanchikSkin } from "@ykurilov/agent-chat-skin-oduvanchik";
import { useCallback, useRef, useState, type ComponentProps, type FormEvent } from "react";
import { ROLE_SWAP_BASE_PATH } from "@/modules/role-swap/base-path";
import type { RoleSwapState } from "@/modules/role-swap";
import { Button, Field, Textarea } from "@/ui/primitives";
import { ConversationBar } from "./conversation-bar";
import { ConversationRoleMenu } from "./conversation-role";
import { CorrectablePreviewChat } from "./preview-corrections";
import { restartRoleSwap, roleSwapState, startRoleSwap, submitRoleSwap } from "./role-swap-actions";

const BRIEF_MAX_CHARS = 1000;

// Эксперт пишет за консультанта, правит реплики клиента
const roleSwapLabels = {
  ...chatLabelsWithToolTitles(russianLabels),
  composerPlaceholder: "Ответьте как консультант…",
  editAnswer: "Поправить",
  answerEdited: "Исправлено",
};

// Модель закреплена в чате при старте: меню моделей в поле ввода нет
const RoleSwapComposer = (props: ComponentProps<ChatSkin["Composer"]>) => <oduvanchikSkin.Composer {...props} modelChoice={undefined} />;
const roleSwapSkin: ChatSkin = { ...oduvanchikSkin, Composer: RoleSwapComposer };

/** Экран старта: кто клиент и «Начать»; при «Начать заново» — ещё и «Отмена». */
function RoleSwapStart({
  leadMagnetId,
  restarting,
  onStarted,
  onCancel,
}: {
  leadMagnetId: string;
  restarting: boolean;
  onStarted(chatId: string): void;
  onCancel?: () => void;
}) {
  const [brief, setBrief] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(event: FormEvent) {
    event.preventDefault();
    setStarting(true);
    setError(null);
    try {
      const run = restarting ? restartRoleSwap : startRoleSwap;
      const result = await run(leadMagnetId, brief.trim() || null);
      if ("chatId" in result) onStarted(result.chatId);
      else setError(result.message);
    } catch {
      setError("Нет связи. Проверьте интернет и попробуйте ещё раз.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <form onSubmit={start} className="mx-auto flex w-full max-w-xl flex-col gap-4 overflow-y-auto px-3 py-6">
      <p>Агент сыграет клиента лидмагнита, а вы ответите ему за консультанта. Если ответ клиента звучит не так, как сказал бы живой человек, поправьте его.</p>
      <Field label="Кто клиент" hint="Необязательно. Опишите, какого клиента хотите встретить: его ситуацию, настроение, сомнения. Пусто — агент придумает сам.">
        <Textarea rows={3} maxLength={BRIEF_MAX_CHARS} value={brief} disabled={starting} onChange={(event) => setBrief(event.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={starting}>
          Начать
        </Button>
        {onCancel ? (
          <Button variant="secondary" disabled={starting} onClick={onCancel}>
            Отмена
          </Button>
        ) : null}
        <ConversationRoleMenu disabled={starting} />
        {starting ? (
          <span role="status" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
            Придумываю клиента…
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** Отдан на разбор и разбор готов (или готовится): второй раз отдавать нечего. Сбой разбора — можно нажать снова. */
const alreadySubmitted = (state: RoleSwapState | null) => state?.finishedReason === "submitted" && state.review !== "failed";

/** «Поменяемся ролями»: агент — клиент лидмагнита, эксперт отвечает за консультанта и правит реплики клиента. */
export function RoleSwapPanel({
  leadMagnetId,
  initial,
  showStage,
  onCorrectionsChanged,
  onSubmitted,
}: {
  leadMagnetId: string;
  initial: RoleSwapState | null;
  /** Этапов разговора больше одного: над перепиской видно, где клиент. */
  showStage: boolean;
  onCorrectionsChanged(): void;
  /** Ответы встали в очередь: пора звать конструктора. */
  onSubmitted(): void;
}) {
  const [chatId, setChatId] = useState(initial?.chatId ?? null);
  const [askingAgain, setAskingAgain] = useState(false);
  const [submitted, setSubmitted] = useState(() => alreadySubmitted(initial));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [stageName, setStageName] = useState(initial?.stageName ?? null);
  const [chatBusy, setChatBusy] = useState(false);

  // Нода меняется после ответа клиента (проверка перехода идёт, пока чат занят) и при переходе на другую ветку
  const busy = useRef(false);
  const lastMessageId = useRef<string | undefined>(undefined);
  const reloadStage = useCallback(() => {
    roleSwapState(leadMagnetId).then((state) => setStageName(state?.stageName ?? null), () => {});
  }, [leadMagnetId]);
  const watchBusy = useCallback(
    (next: boolean) => {
      if (busy.current && !next) reloadStage();
      busy.current = next;
      setChatBusy(next);
    },
    [reloadStage],
  );
  const watchFeed = useCallback(
    (feed: { messages: ReadonlyArray<{ id: string }> }) => {
      const last = feed.messages.at(-1)?.id;
      if (last === lastMessageId.current) return;
      lastMessageId.current = last;
      if (!busy.current) reloadStage();
    },
    [reloadStage],
  );

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await submitRoleSwap(leadMagnetId);
      if (result.ok) {
        setSubmitted(true);
        // Записывать было нечего (ни одного ответа или уже записаны) — конструктору разбирать нечего
        if (result.recorded > 0) onSubmitted();
      } else setSubmitError(result.message);
    } catch {
      setSubmitError("Нет связи. Проверьте интернет и попробуйте ещё раз.");
    } finally {
      setSubmitting(false);
    }
  }

  // Главное в поле — ответить клиенту: «Закончить и разобрать» контурная, слева, подальше от стрелки отправки.
  // Видна и в закрытом чате: клиент ушёл — отдать на разбор можно
  const composerActions = (composer: ComposerHelper) => (
    <div className="app-composer-actions">
      {submitted ? null : (
        <Button variant="outline" size="sm" loading={submitting} disabled={composer.busy || submitting} onClick={() => void submit()}>
          Закончить и разобрать
        </Button>
      )}
      <ConversationRoleMenu />
    </div>
  );

  if (!chatId || askingAgain)
    return (
      <RoleSwapStart
        leadMagnetId={leadMagnetId}
        restarting={Boolean(chatId)}
        onStarted={(next) => {
          setChatId(next);
          setStageName(null);
          setSubmitted(false);
          setSubmitError(null);
          setAskingAgain(false);
        }}
        {...(chatId && { onCancel: () => setAskingAgain(false) })}
      />
    );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* Где сейчас разговор по сценарию и «Начать заново» — как в «Проверке» */}
      <ConversationBar onRestart={() => setAskingAgain(true)} restartDisabled={chatBusy || submitting}>
        {showStage && stageName ? `Этап: ${stageName}` : null}
      </ConversationBar>
      <div className="min-h-0 flex-1">
        <ChatLabelsProvider labels={roleSwapLabels}>
          <CorrectablePreviewChat
            key={chatId}
            api={ROLE_SWAP_BASE_PATH}
            chatId={chatId}
            skin={roleSwapSkin}
            composerActions={composerActions}
            onBusyChange={watchBusy}
            onFeedChange={watchFeed}
            onCorrectionsChanged={onCorrectionsChanged}
          />
        </ChatLabelsProvider>
      </div>
      {submitting ? (
        <p role="status" className="px-3 text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          Готовлю разбор…
        </p>
      ) : null}
      {submitError ? (
        <p role="alert" className="px-3 text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">
          {submitError}
        </p>
      ) : null}
    </div>
  );
}
