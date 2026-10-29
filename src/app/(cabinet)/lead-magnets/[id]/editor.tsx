"use client";

import Link from "next/link";
import {
  AgentChat,
  ChatLabelsProvider,
  russianLabels,
  type ChatSkin,
} from "@ykurilov/agent-chat-react";
import { oduvanchikSkin } from "@ykurilov/agent-chat-skin-oduvanchik";
import { flowNoticeLines } from "@ykurilov/agent-chat-flows/react";
import { flowLabels } from "@/ui/flow-labels";
import { imageLibraryClient } from "@ykurilov/agent-chat-image-library/react";
import { videosClient } from "@ykurilov/agent-chat-videos/react";
import { withWebToolTitles } from "@ykurilov/agent-chat-web-tools/labels";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ComponentProps,
} from "react";
import { Alert, Badge, Button, cn } from "@/ui/primitives";
import type { PreviewStatus } from "@/modules/consultant";
import type { LeadMagnetSettings } from "@/modules/lead-magnets";
import type { FieldDefinition } from "@/modules/people";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui";
import { advancePreviewAction, advancePreviewToReminderAction, nextPreviewDayAction, restartPreviewAction } from "../actions";
import { OUTREACH_REQUEST_TEXT } from "@/modules/consultant/outreach-request";
import { hasUnsavedFlowEdit, keepBoardLayout } from "@/modules/flows/board-draft";
import { HistoryTab, type VersionRow } from "./history-tab";
import { useBoardLayout } from "../../board-layout";
import { FlowTab } from "./flow-tab";
import { LogTab } from "./log-tab";
import { RewindControls } from "./rewind-controls";
import { SettingsTab, type ArchiveImage, type ArchiveVideo } from "./settings-tab";
import { withSingleReply } from "./single-reply-skin";
import { PreviewProductLinks, withTaggedProductLinks } from "./product-links-skin";

// Модель выбирает эксперт во вкладке «Настройки», поэтому в поле ввода меню моделей нет
const constructorLabels = {
  ...russianLabels,
  composerPlaceholder: "Опишите, что поменять…",
};
// Консультант может смотреть ссылки клиента: вызов снимка подписан по-русски
const previewLabels = {
  ...withWebToolTitles(russianLabels),
  composerPlaceholder: "Напишите как клиент…",
};

/** Почему отправка конструктору сейчас закрыта; `null` — открыта. */
const ConstructorSendBlock = createContext<string | null>(null);
const SEND_BLOCK_HINT_ID = "constructor-send-block";

/** Пустой ли чат конструктора: пока да, над полем ввода — приветствие и подсказки. */
const ConstructorChatEmpty = createContext(false);

const CONSTRUCTOR_SUGGESTIONS = [
  "Сделай мини-диагностику для моих клиентов",
  "Квиз, который подводит к консультации",
  "Разговор, который помогает выбрать тариф",
];

function ConstructorWelcome({ onPick }: { onPick(text: string): void }) {
  return (
    <div className="flex flex-col gap-2 text-[length:var(--yk-text-small-size)]">
      <p>
        Привет! Я конструктор. Расскажите, какой лидмагнит вам нужен: я соберу
        его и буду править по вашим словам. Можно начать с примера:
      </p>
      <div className="flex flex-wrap gap-2">
        {CONSTRUCTOR_SUGGESTIONS.map((text) => (
          <Button
            key={text}
            variant="secondary"
            size="sm"
            onClick={() => onPick(text)}
          >
            {text}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ConstructorComposer(props: ComponentProps<ChatSkin["Composer"]>) {
  const blockedBecause = useContext(ConstructorSendBlock);
  const chatEmpty = useContext(ConstructorChatEmpty);
  const welcome = chatEmpty ? (
    <ConstructorWelcome onPick={props.onValueChange} />
  ) : null;
  if (!blockedBecause)
    return (
      <div className="flex flex-col gap-2">
        {welcome}
        <oduvanchikSkin.Composer {...props} modelChoice={undefined} />
      </div>
    );
  return (
    <div className="flex flex-col gap-1">
      {welcome}
      <oduvanchikSkin.Composer
        {...props}
        modelChoice={undefined}
        canSubmit={false}
        onSubmit={() => undefined}
        sendingBlocked
        sendingBlockedReasonId={SEND_BLOCK_HINT_ID}
      />
      <p
        id={SEND_BLOCK_HINT_ID}
        role="status"
        className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]"
      >
        {blockedBecause}
      </p>
    </div>
  );
}

/** Пока эксперт не написал в проверке ни слова, над полем ввода — пояснение, кто здесь кто. */
const PreviewChatStarted = createContext(true);

/** Консультант завершил тестовый разговор: писать дальше некуда, только начать заново. */
const PreviewFinished = createContext(false);
const PREVIEW_FINISHED_HINT_ID = "preview-finished";

function PreviewComposer(props: ComponentProps<ChatSkin["Composer"]>) {
  const started = useContext(PreviewChatStarted);
  const finished = useContext(PreviewFinished);
  if (finished)
    return (
      <div className="flex flex-col gap-1">
        <oduvanchikSkin.Composer
          {...props}
          modelChoice={undefined}
          canSubmit={false}
          onSubmit={() => undefined}
          sendingBlocked
          sendingBlockedReasonId={PREVIEW_FINISHED_HINT_ID}
        />
        <p
          id={PREVIEW_FINISHED_HINT_ID}
          role="status"
          className="sr-only"
        >
          Чтобы пройти разговор ещё раз, нажмите «Начать проверку заново».
        </p>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      {started ? null : (
        <p className="text-[length:var(--yk-text-small-size)]">
          Здесь вы — клиент. Пишите как он и смотрите, как отвечает лидмагнит.
        </p>
      )}
      <oduvanchikSkin.Composer {...props} modelChoice={undefined} />
    </div>
  );
}

const constructorSkin: ChatSkin = {
  ...oduvanchikSkin,
  Composer: ConstructorComposer,
  // The app already provides its own introduction and starter examples by the composer.
  Layout: (props) => <oduvanchikSkin.Layout {...props} empty={false} />,
};

/** Служебная просьба «напиши первым» лежит в истории для модели; эксперт её в проверке не видит, как и человек в мессенджере. */
const PreviewUserMessage: ChatSkin["UserMessage"] = (props) =>
  props.text === OUTREACH_REQUEST_TEXT ? null : <oduvanchikSkin.UserMessage {...props} />;

const previewSkin: ChatSkin = withSingleReply(
  withTaggedProductLinks({
    ...oduvanchikSkin,
    Composer: PreviewComposer,
    UserMessage: PreviewUserMessage,
  }),
);

/** Ширина, с которой конструктор и вкладки стоят рядом, а не переключаются (брейкпоинт lg). */
const WIDE_SCREEN = "(min-width: 64rem)";

function subscribeToWideScreen(onChange: () => void) {
  const query = window.matchMedia(WIDE_SCREEN);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Широкий ли экран; на сервере считаем широким, телефон уточнится после загрузки. */
function useWideScreen() {
  return useSyncExternalStore(
    subscribeToWideScreen,
    () => window.matchMedia(WIDE_SCREEN).matches,
    () => true,
  );
}

/** Мягкое предупреждение: правка эксперта легла поверх черновика, который успел измениться. */
function DraftOverwriteNotice({ onDismiss }: { onDismiss(): void }) {
  return (
    <Alert
      variant="warm"
      title="Черновик успел измениться"
      className="mb-3"
      action={
        <Button variant="secondary" size="sm" onClick={onDismiss}>
          Понятно
        </Button>
      }
    >
      Пока вы правили, черновик изменил конструктор или другой эксперт.
      Сохранена ваша версия, конструктор получил об этом заметку. Чужая правка
      есть во вкладке «История».
    </Alert>
  );
}

export interface EditorProps {
  leadMagnetId: string;
  draft: LeadMagnetSettings;
  draftVersionId: string;
  constructorChatId: string;
  constructorHasMessages: boolean;
  preview: PreviewStatus;
  versions: VersionRow[];
  fields: FieldDefinition[];
  videos: ArchiveVideo[];
  images: ArchiveImage[];
}

export function Editor({
  leadMagnetId,
  draft,
  draftVersionId,
  constructorChatId,
  constructorHasMessages,
  preview,
  versions,
  fields,
  videos,
  images,
}: EditorProps) {
  const router = useRouter();
  const [restarting, startRestart] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const [constructorBusy, setConstructorBusy] = useState(false);
  const [constructorStarted, setConstructorStarted] = useState(
    constructorHasMessages,
  );
  const [previewStarted, setPreviewStarted] = useState(false);
  // На узком экране конструктор — отдельная вкладка и открыт первым; на широком он всегда слева, а справа «Разговор»
  const wide = useWideScreen();
  const [tab, setTab] = useState("constructor");
  const shownTab = wide && tab === "constructor" ? "preview" : tab;
  // Доске нужно всё окно: кабинет сворачивает меню и убирает поля, шапка страницы ужимается
  const boardFull = shownTab === "flow";
  useBoardLayout(boardFull);
  const [settingsDirty, setSettingsDirty] = useState(false);
  // Сценарий на доске: хранится здесь, чтобы правка пережила переключение вкладок. Новая версия черновика — доска заново,
  // карточки остаются там, куда их поставили
  const [boardFlow, setBoardFlow] = useState(draft.flow);
  const [boardVersionId, setBoardVersionId] = useState(draftVersionId);
  if (boardVersionId !== draftVersionId) {
    setBoardVersionId(draftVersionId);
    setBoardFlow(keepBoardLayout(draft.flow, boardFlow));
  }
  const flowDirty = hasUnsavedFlowEdit(boardFlow, draft.flow);
  const [overwroteNewerDraft, setOverwroteNewerDraft] = useState(false);
  const [savedVersionId, setSavedVersionId] = useState<string | null>(null);
  const overwriteNotice = overwroteNewerDraft ? (
    <DraftOverwriteNotice onDismiss={() => setOverwroteNewerDraft(false)} />
  ) : null;

  // Ход закончился — черновик или состояние разговора могли измениться
  const wasBusy = useRef<Record<string, boolean>>({});
  const watchTurns = useCallback(
    (chat: "constructor" | "preview") => (busy: boolean) => {
      if (wasBusy.current[chat] && !busy) startRefresh(() => router.refresh());
      wasBusy.current[chat] = busy;
      if (chat === "constructor") {
        setConstructorBusy(busy);
        if (busy) setConstructorStarted(true);
      } else if (busy) setPreviewStarted(true);
    },
    [router],
  );
  const [onConstructorBusy] = useState(() => watchTurns("constructor"));
  const [onPreviewBusy] = useState(() => watchTurns("preview"));

  // Первая версия создаётся вместе с лидмагнитом; всё, что после неё (конструктор, правка, откат), — собранный черновик
  const hasDraft = versions.length > 1;

  // Черновик правит конструктор (или страница ещё подтягивает его правку) — ручные правки и откат закрыты
  const draftLocked = constructorBusy || refreshing;

  // Правка в «Настройках» или на доске, пока не сохранена, закрывает отправку конструктору и сохранение в другой вкладке
  const constructorSendBlock = settingsDirty
    ? "Сначала сохраните или отмените правку в Настройках"
    : flowDirty
      ? "Сначала сохраните правку на вкладке «Сценарий»"
      : null;

  const [nextDayError, setNextDayError] = useState<string | null>(null);
  const [shiftingDay, startShiftDay] = useTransition();
  // Пояс браузера: по нему дни тестового разговора, если эксперт ещё не писал
  const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shiftPreview = (shift: () => Promise<string | void>, failure: string) =>
    startShiftDay(async () => {
      setNextDayError(null);
      try {
        const notice = await shift();
        if (notice) setNextDayError(notice);
      } catch {
        setNextDayError(failure);
      }
      router.refresh();
    });
  const nextDay = () =>
    shiftPreview(() => nextPreviewDayAction(leadMagnetId, browserTimeZone()), "Не получилось перейти к следующему дню. Попробуйте ещё раз.");
  const nextReminder = () =>
    shiftPreview(async () => {
      const { nothingScheduled } = await advancePreviewToReminderAction(leadMagnetId, browserTimeZone());
      if (nothingScheduled) return "Впереди нет запланированных сообщений: агент сейчас первым не напишет";
    }, "Не получилось промотать к напоминанию. Попробуйте ещё раз.");
  const rewind = (ms: number) =>
    shiftPreview(() => advancePreviewAction(leadMagnetId, ms, browserTimeZone()), "Не получилось промотать время. Попробуйте ещё раз.");

  const restart = () =>
    startRestart(async () => {
      await restartPreviewAction(leadMagnetId);
      setPreviewStarted(false);
      router.refresh();
    });

  return (
    // Редактор занимает окно целиком: data-fill-window растягивает область контента на высоту окна (globals.css)
    <Tabs
      value={shownTab}
      onValueChange={setTab}
      data-fill-window=""
      className={cn("flex min-h-0 flex-1 flex-col", boardFull ? "gap-0" : "gap-[var(--yk-space-4)]")}
    >
      {/* Название, «Публикация» и вкладки — одна строка: отдельной полосы под название нет */}
      <header
        className={cn(
          "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 lg:flex-nowrap",
          // На доске поля кабинета убраны: строке — свои небольшие отступы
          boardFull && "gap-y-1 px-3 py-1.5",
        )}
      >
        <div className="flex min-w-0 items-baseline gap-x-3">
          <h1 className="min-w-0 truncate text-[length:var(--yk-text-body-size)] font-semibold" title={draft.name}>
            {draft.name}
          </h1>
          <Link
            href={`/lead-magnets/${leadMagnetId}/publish`}
            className="app-focus shrink-0 text-[length:var(--yk-text-small-size)] underline"
          >
            Публикация
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-lg:w-full lg:shrink-0">
          {/* На узком экране вкладки переносятся на вторую строку и растягиваются: все видны сразу, без скрытой прокрутки */}
          <TabsList className="max-lg:flex max-lg:w-full max-lg:flex-wrap max-lg:[&>*]:flex-auto">
            {wide ? null : (
              <TabsTrigger value="constructor">Конструктор</TabsTrigger>
            )}
            <TabsTrigger value="preview">Разговор</TabsTrigger>
            <TabsTrigger value="flow">Сценарий</TabsTrigger>
            <TabsTrigger value="settings">Настройки</TabsTrigger>
            <TabsTrigger value="history">История</TabsTrigger>
            <TabsTrigger value="log">Лог</TabsTrigger>
          </TabsList>
          {hasDraft ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={restart}
              loading={restarting}
            >
              Начать проверку заново
            </Button>
          ) : null}
        </div>
      </header>
      <div className={cn("flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-2", boardFull ? "gap-0" : "gap-[var(--yk-space-6)]")}>
        {/* На широком экране это просто левая колонка, а не панель вкладки */}
        <TabsContent
          value="constructor"
          forceMount
          {...(wide
            ? { role: undefined, "aria-labelledby": undefined, tabIndex: undefined }
            : {})}
          className={cn(
            "mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:max-lg:hidden",
            // Доске нужна вся ширина: конструктор остаётся в странице и вернётся с историей чата
            shownTab === "flow" && "lg:hidden",
          )}
        >
          <section aria-label="Конструктор" className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              <ConstructorSendBlock.Provider
                value={constructorSendBlock}
              >
                <ConstructorChatEmpty.Provider value={!constructorStarted}>
                  <ChatLabelsProvider labels={constructorLabels}>
                    <AgentChat
                      key={constructorChatId}
                      api="/api/constructor"
                      chatId={constructorChatId}
                      skin={constructorSkin}
                      onBusyChange={onConstructorBusy}
                    />
                  </ChatLabelsProvider>
                </ConstructorChatEmpty.Provider>
              </ConstructorSendBlock.Provider>
            </div>
          </section>
        </TabsContent>

        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            shownTab === "constructor" && "max-lg:hidden",
            shownTab === "flow" && "lg:col-span-2",
          )}
        >
            <TabsContent
              value="preview"
              className="flex min-h-0 flex-1 flex-col gap-2"
            >
              {preview.stageName || preview.finished || preview.day !== null ? (
                <div className="flex flex-wrap items-center gap-2 text-[length:var(--yk-text-small-size)]">
                  {preview.day !== null ? (
                    <Badge variant="cool">
                      День {preview.day}
                      {preview.days !== null ? ` из ${preview.days}` : ""} · {preview.stageName}
                    </Badge>
                  ) : preview.stageName ? (
                    <Badge variant="cool">Этап: {preview.stageName}</Badge>
                  ) : null}
                  {preview.day !== null && preview.days !== null && hasDraft ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={nextDay}
                      loading={shiftingDay}
                      disabled={preview.finished || preview.day >= preview.days}
                    >
                      К началу следующего дня
                    </Button>
                  ) : null}
                  {hasDraft ? <RewindControls onRewind={rewind} onNextReminder={nextReminder} disabled={preview.finished || shiftingDay} /> : null}
                  {preview.finished ? (
                    <Badge variant="success">Диалог завершён</Badge>
                  ) : null}
                </div>
              ) : null}
              {nextDayError ? (
                <p role="alert" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">
                  {nextDayError}
                </p>
              ) : null}
              <div className="min-h-0 flex-1">
                {hasDraft ? (
                  <PreviewChatStarted.Provider value={previewStarted}>
                    <PreviewFinished.Provider value={preview.finished}>
                      <ChatLabelsProvider labels={previewLabels}>
                        <PreviewProductLinks.Provider value={{ products: draft.productLinks ?? [], chatId: preview.chatId }}>
                          {/* Разговор завершился — лента читается заново */}
                          <AgentChat
                            key={`${preview.chatId}:${preview.finished ? "finished" : "open"}:${preview.day ?? 0}`}
                            api="/api/preview"
                            chatId={preview.chatId}
                            skin={previewSkin}
                            videos={videosClient}
                            images={imageLibraryClient}
                            noticeLines={flowNoticeLines(flowLabels.notices)}
                            onBusyChange={onPreviewBusy}
                          />
                        </PreviewProductLinks.Provider>
                      </ChatLabelsProvider>
                    </PreviewFinished.Provider>
                  </PreviewChatStarted.Provider>
                ) : (
                  <Alert title="Здесь вы — клиент">
                    Пишите как он и смотрите, как отвечает лидмагнит. Проверка
                    появится, когда конструктор соберёт первый черновик.
                  </Alert>
                )}
              </div>
            </TabsContent>

            <TabsContent value="flow" className="flex min-h-0 flex-1 flex-col">
              {overwriteNotice}
              <FlowTab
                leadMagnetId={leadMagnetId}
                draftVersionId={draftVersionId}
                value={boardFlow}
                savedValue={draft.flow}
                onChange={setBoardFlow}
                fields={fields}
                locked={draftLocked}
                saveBlockedBecause={
                  settingsDirty ? "Сначала сохраните или отмените правку в «Настройках»: после сохранения доска откроется заново" : null
                }
                onSaved={(result) => {
                  setOverwroteNewerDraft(result.overwroteNewerDraft);
                  router.refresh();
                }}
                renderChat={(chatId, { noticeLines }) => (
                  <PreviewChatStarted.Provider value>
                    <PreviewFinished.Provider value={false}>
                      <ChatLabelsProvider labels={previewLabels}>
                        <PreviewProductLinks.Provider value={{ products: draft.productLinks ?? [], chatId }}>
                          <AgentChat key={chatId} api="/api/preview" chatId={chatId} skin={previewSkin} videos={videosClient} images={imageLibraryClient} noticeLines={noticeLines} onBusyChange={onPreviewBusy} />
                        </PreviewProductLinks.Provider>
                      </ChatLabelsProvider>
                    </PreviewFinished.Provider>
                  </PreviewChatStarted.Provider>
                )}
                onPreviewRestarted={() => {
                  setPreviewStarted(false);
                  router.refresh();
                }}
              />
            </TabsContent>

            <TabsContent
              value="settings"
              forceMount
              className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden"
            >
              {draftLocked ? (
                <Alert title="Конструктор правит черновик…" className="mb-3" />
              ) : null}
              {overwriteNotice}
              {/* Новая версия черновика (например, от конструктора) — форма заново с новыми значениями */}
              <SettingsTab
                key={draftVersionId}
                leadMagnetId={leadMagnetId}
                draft={draft}
                draftVersionId={draftVersionId}
                videos={videos}
                images={images}
                locked={draftLocked}
                saveBlockedBecause={flowDirty ? "Сначала сохраните или отмените правку на вкладке «Сценарий»" : null}
                justSaved={savedVersionId === draftVersionId}
                onDirtyChange={setSettingsDirty}
                onSaved={(result) => {
                  setSavedVersionId(result.versionId);
                  setOverwroteNewerDraft(result.overwroteNewerDraft);
                }}
              />
            </TabsContent>

            <TabsContent
              value="history"
              className="min-h-0 flex-1 overflow-y-auto"
            >
              {overwriteNotice}
              <HistoryTab
                leadMagnetId={leadMagnetId}
                versions={versions}
                currentVersionId={draftVersionId}
                locked={draftLocked}
                onRolledBack={setOverwroteNewerDraft}
              />
            </TabsContent>

            <TabsContent value="log" className="min-h-0 flex-1 overflow-y-auto">
              <LogTab leadMagnetId={leadMagnetId} />
            </TabsContent>
        </div>
      </div>
    </Tabs>
  );
}
