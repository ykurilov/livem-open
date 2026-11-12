"use client";

import {
  AgentChat,
  ChatLabelsProvider,
  russianLabels,
  type ChatSkin,
  type ComposerHelper,
} from "@ykurilov/agent-chat-react";
import { oduvanchikSkin } from "@ykurilov/agent-chat-skin-oduvanchik";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { flowNoticeLines } from "@ykurilov/agent-chat-flows/react";
import { flowLabels } from "@/ui/flow-labels";
import { imageLibraryClient } from "@ykurilov/agent-chat-image-library/react";
import { videosClient } from "@ykurilov/agent-chat-videos/react";
import { attachmentsClient } from "@ykurilov/agent-chat-attachments/react";
import { createVoiceInput } from "@ykurilov/agent-chat-voice";
import { chatLabelsWithToolTitles } from "@/modules/agent-log/tool-titles";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ComponentProps,
} from "react";
import { Button as DesignButton } from "@ykurilov/ds-react";
import { Alert, Button, cn } from "@/ui/primitives";
import type { PreviewStatus } from "@/modules/consultant";
import type { LeadMagnetSettings } from "@/modules/lead-magnets";
import type { RoleSwapState } from "@/modules/role-swap";
import type { FieldDefinition } from "@/modules/people";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui";
import { IconButton } from "@/ui/icon-button";
import { advancePreviewAction, advancePreviewToReminderAction, nextPreviewDayAction, reopenPreviewAction, restartPreviewAction, suggestPreviewReplyAction } from "../actions";
import { pendingCorrectionsCount } from "./corrections-actions";
import { OUTREACH_REQUEST_TEXT } from "@/modules/consultant/outreach-request";
import { hasUnsavedFlowEdit, keepBoardLayout } from "@/modules/flows/board-draft";
import { HistoryTab, type VersionRow } from "./history-tab";
import { useLeaveConfirmation } from "./leave-confirmation";
import { useBoardLayout } from "../../board-layout";
import { LogTab } from "./log-tab";
import { RewindControls, type RewindControlsProps } from "./rewind-controls";
import type { ModelMenu } from "@ykurilov/agent-chat-core";
import { SettingsTab, type ArchiveImage, type ArchiveKnowledge, type ArchiveVideo } from "./settings-tab";
import { withSingleReply } from "./single-reply-skin";
import { PreviewProductLinks, withTaggedProductLinks } from "./product-links-skin";
import { CorrectablePreviewChat } from "./preview-corrections";
import { SidebarSimpleIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { CONSTRUCTOR_PANEL_COOKIE } from "./constructor-panel-cookie";
import { RoleSwapPanel } from "./role-swap-panel";
import { ConversationBar } from "./conversation-bar";
import { ConversationRoleContext, ConversationRoleMenu, type ConversationRole } from "./conversation-role";
import { showsStage } from "./stage-line";
import { ROLE_SWAP_MODE_COOKIE } from "./role-swap-cookie";

// Доска сценария — самая тяжёлая часть редактора и нужна только на вкладке «Сценарий»: редактор оживает без неё,
// а код доски догружается, пока эксперт смотрит на страницу. Без Suspense: React показывает содержимое после заглушки
// не раньше чем через 300 мс, и вкладка с уже скачанной доской открывалась бы медленнее
type FlowTabComponent = typeof import("./flow-tab").FlowTab;
let loadedFlowTab: FlowTabComponent | null = null;
const loadFlowTab = () => import("./flow-tab").then((module) => (loadedFlowTab = module.FlowTab));

function useFlowTab(needed: boolean): FlowTabComponent | null {
  const [FlowTab, setFlowTab] = useState(() => loadedFlowTab);
  useEffect(() => {
    if (FlowTab) return;
    let cancelled = false;
    const load = () => void loadFlowTab().then((component) => !cancelled && setFlowTab(() => component));
    if (needed) load();
    else if ("requestIdleCallback" in window) {
      const handle = requestIdleCallback(load, { timeout: 3000 });
      return () => {
        cancelled = true;
        cancelIdleCallback(handle);
      };
    } else {
      const handle = setTimeout(load, 1000);
      return () => {
        cancelled = true;
        clearTimeout(handle);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [FlowTab, needed]);
  return FlowTab;
}

// Плашки инструментов во всех чатах редактора — с названиями для эксперта, а не со служебными именами
const editorLabels = chatLabelsWithToolTitles(russianLabels);
// Модель выбирает эксперт во вкладке «Настройки», поэтому в поле ввода меню моделей нет
const constructorLabels = {
  ...editorLabels,
  composerPlaceholder: "Опишите, что поменять…",
};
// Черновика ещё нет: менять нечего, конструктор ждёт описание лидмагнита
const emptyConstructorLabels = {
  ...editorLabels,
  composerPlaceholder: "Опишите лидмагнит, который нужен…",
};
const previewLabels = {
  ...editorLabels,
  composerPlaceholder: "Напишите как клиент…",
  editAnswer: "Поправить",
  answerEdited: "Исправлено",
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

/**
 * Консультант завершил тестовый разговор: писать дальше — после «Продолжить разговор»; своя реплика правится и так.
 * `null` — разговор идёт.
 */
interface PreviewEnd {
  reopen(): void;
  reopening: boolean;
  /** «Продолжить разговор» не вышло: почему и что делать. */
  error: string | null;
}
const PreviewEnd = createContext<PreviewEnd | null>(null);

/** Часы тестового разговора — в поле ввода «Разговора»; на доске свои. */
interface PreviewClock {
  rewind: Omit<RewindControlsProps, "disabled">;
  shifting: boolean;
}
const PreviewClock = createContext<PreviewClock | null>(null);

/**
 * Сколько раз тестовый разговор менялся помимо «Автоответа»: ход, промотка, «Начать заново», «Продолжить».
 * Ответ «Автоответа», за время которого счёт сдвинулся, устарел и не отправляется.
 */
const PreviewRevision = createContext<() => number>(() => 0);

function PreviewComposer(props: ComponentProps<ChatSkin["Composer"]>) {
  const end = useContext(PreviewEnd);
  const clock = useContext(PreviewClock);
  // Пустое поле с недоступной стрелкой обещает ввод, которого нет: вместо него — плашка конца с одним действием
  if (end)
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--yk-radius-composer)] bg-[var(--yk-surface-2)] px-5 py-4"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="inline-flex items-center gap-1.5 font-medium text-[var(--yk-success)]">
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            Диалог завершён
          </span>
          <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
            Чтобы писать дальше, продолжите разговор.
          </span>
        </div>
        <span className="inline-flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={end.reopen} loading={end.reopening}>
            Продолжить разговор
          </Button>
          <ConversationRoleMenu />
        </span>
        {end.error ? (
          <p role="alert" className="basis-full text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">
            {end.error}
          </p>
        ) : null}
      </div>
    );
  return (
    <oduvanchikSkin.Composer
      {...props}
      modelChoice={undefined}
      actions={
        <div className="app-composer-actions">
          {props.actions}
          {clock ? <RewindControls {...clock.rewind} disabled={props.busy || clock.shifting} /> : null}
          <ConversationRoleMenu />
        </div>
      }
    />
  );
}

/** Кнопки поля ввода тестового разговора, которым нужна отправка: её даёт только помощник чата. */
/** Диктовка в «Проверке» через сервер приложения: ключ Soniox остаётся на сервере, доступ — по черновику лидмагнита. */
const previewVoice = createVoiceInput({ api: "/api/voice", mode: "relay" });
const previewComposerActions = (composer: ComposerHelper) => <AutoreplyButton canSend={composer.canSend} onReply={composer.send} />;

/** «Автоответ»: модель пишет за клиента ответ на последнюю реплику консультанта и сразу отправляет его; не понравился — эксперт правит свою реплику в ленте. */
function AutoreplyButton({ canSend, onReply }: { canSend: boolean; onReply(text: string): void }) {
  const chatId = useContext(PreviewProductLinks)?.chatId;
  const revision = useContext(PreviewRevision);
  const [pending, startSuggest] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!chatId) return null;
  const suggest = () =>
    startSuggest(async () => {
      setError(null);
      const askedAt = revision();
      let result: Awaited<ReturnType<typeof suggestPreviewReplyAction>>;
      try {
        result = await suggestPreviewReplyAction(chatId);
      } catch {
        result = { error: "Не получилось придумать ответ: нет связи с сервером. Попробуйте ещё раз." };
      }
      // Пока модель думала, эксперт написал сам, промотал время или начал заново: ответ уже не к месту
      if (revision() !== askedAt) return;
      if ("text" in result) onReply(result.text);
      else setError(result.error);
    });
  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="secondary" size="sm" disabled={!canSend || pending} onClick={suggest} title="Ответить за клиента: ответ уйдёт сразу, потом его можно исправить в ленте">
        <SparkleIcon aria-hidden />
        {pending ? "Придумываю…" : "Автоответ"}
      </Button>
      {error ? (
        <span role="alert" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** Просьба одинакова при каждом нажатии: правки конструктор читает сам, а текст в истории остаётся прежним. */
const ANSWER_CORRECTIONS_REQUEST = "Разбери правки ответов консультанта.";

/** Просьба разобрать правки, заказанная извне чата конструктора: уходит, как только конструктор может принять сообщение. */
function QueuedCorrectionsRequest({ composer, onSent }: { composer: ComposerHelper; onSent(): void }) {
  const latest = useRef({ composer, onSent });
  latest.current = { composer, onSent };
  const { canSend } = composer;
  useEffect(() => {
    if (!canSend) return;
    latest.current.composer.send(ANSWER_CORRECTIONS_REQUEST);
    latest.current.onSent();
  }, [canSend]);
  return null;
}

/**
 * «Разобрать правки (N)»: эксперт одним нажатием просит конструктор разобрать накопленные правки; без правок кнопки нет.
 * `queued` — просьбу заказала «Закончить и разобрать» в «Поменяемся ролями».
 */
const correctionsComposerActions = (count: number, queued: boolean, onQueuedSent: () => void) =>
  function CorrectionsComposerActions(composer: ComposerHelper) {
    return (
      <>
        {queued ? <QueuedCorrectionsRequest composer={composer} onSent={onQueuedSent} /> : null}
        {count > 0 ? (
          <Button variant="secondary" size="sm" disabled={!composer.canSend} onClick={() => composer.send(ANSWER_CORRECTIONS_REQUEST)}>
            Разобрать правки ({count})
          </Button>
        ) : null}
      </>
    );
  };

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
  /** Запрос пришёл с телефона: панель конструктора там на весь экран, сохранённое «открыта» её не открывает. */
  onPhone?: boolean;
  /** Эксперт оставил панель конструктора открытой (кука этого браузера). */
  constructorPanelOpen?: boolean;
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
  knowledge: ArchiveKnowledge[];
  modelMenu: ModelMenu;
  /** Правок ответов консультанта, которые конструктор ещё не разобрал. */
  pendingCorrections?: number;
  /** Разговор «Поменяемся ролями» лидмагнита; `null` — ещё не начинали. */
  roleSwap?: RoleSwapState | null;
  /** Эксперт оставил «Разговор» в режиме «Я отвечаю за консультанта» (кука этого браузера). */
  roleSwapMode?: boolean;
  /** На сервере есть ключ Soniox: «Голосовой ввод» лидмагнита даёт микрофон и в «Проверке». */
  voiceAvailable?: boolean;
}

export function Editor({
  onPhone = false,
  constructorPanelOpen = false,
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
  knowledge,
  modelMenu,
  pendingCorrections = 0,
  roleSwap = null,
  roleSwapMode = false,
  voiceAvailable = false,
}: EditorProps) {
  const router = useRouter();
  const [restarting, startRestart] = useTransition();
  const [reopening, startReopen] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const [constructorBusy, setConstructorBusy] = useState(false);
  const [constructorStarted, setConstructorStarted] = useState(
    constructorHasMessages,
  );
  const [tab, setTab] = useState("preview");
    // Доске нужно всё окно: кабинет сворачивает меню и убирает поля, шапка страницы ужимается
  const boardFull = tab === "flow";
  const FlowTab = useFlowTab(boardFull);
  useBoardLayout(boardFull);
  // Несохранённая правка «Настроек»: доска сохраняет её вместе со сценарием, чтобы ни одна вкладка не ждала другую
  const [settingsEdit, setSettingsEdit] = useState<LeadMagnetSettings | null>(null);
  const settingsDirty = settingsEdit !== null;
  // Правка «Настроек», ушедшая с сохранением доски, и версия, которую оно дало: форма узнаёт в ней свою правку
  const [settingsSentWithBoard, setSettingsSentWithBoard] = useState<{ versionId: string; settings: LeadMagnetSettings } | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  // Сценарий на доске: хранится здесь, чтобы правка пережила переключение вкладок. Новая версия черновика — доска заново,
  // карточки остаются там, куда их поставили
  const [boardFlow, setBoardFlow] = useState(draft.flow);
  // Сценарий, ушедший с последним сохранением из этого окна (с доски или вместе с «Настройками»)
  const [boardSent, setBoardSent] = useState<AgentFlow | null>(null);
  const [boardBase, setBoardBase] = useState({ versionId: draftVersionId, flow: draft.flow });
  if (boardBase.versionId !== draftVersionId) {
    setBoardBase({ versionId: draftVersionId, flow: draft.flow });
    setBoardSent(null);
    // Правка, начатая после сохранения, пока страница дочитывала новую версию, остаётся на доске
    const editedSince = hasUnsavedFlowEdit(boardFlow, boardSent ?? boardBase.flow) && hasUnsavedFlowEdit(boardFlow, draft.flow);
    if (!editedSince) setBoardFlow(keepBoardLayout(draft.flow, boardFlow));
  }
  const flowDirty = hasUnsavedFlowEdit(boardFlow, draft.flow);
  const [overwroteNewerDraft, setOverwroteNewerDraft] = useState(false);
  const [savedVersionId, setSavedVersionId] = useState<string | null>(null);
  const overwriteNotice = overwroteNewerDraft ? (
    <DraftOverwriteNotice onDismiss={() => setOverwroteNewerDraft(false)} />
  ) : null;

  // Ход закончился — черновик или состояние разговора могли измениться
  // Ключи заданы явно: у пустого объекта `{}["constructor"]` — встроенная функция, и открытие редактора считалось концом хода
  const wasBusy = useRef<Record<"constructor" | "preview", boolean>>({ constructor: false, preview: false });
  const watchTurns = useCallback(
    (chat: "constructor" | "preview") => (busy: boolean) => {
      if (wasBusy.current[chat] && !busy) startRefresh(() => router.refresh());
      wasBusy.current[chat] = busy;
      if (chat === "constructor") {
        setConstructorBusy(busy);
        if (busy) setConstructorStarted(true);
      }
    },
    [router],
  );
  // Счёт правок: страница даёт первое значение, ход конструктора мог разобрать правки — после хода число читается заново
  const [correctionsCount, setCorrectionsCount] = useState(pendingCorrections);
  const [shownPendingCorrections, setShownPendingCorrections] = useState(pendingCorrections);
  if (shownPendingCorrections !== pendingCorrections) {
    setShownPendingCorrections(pendingCorrections);
    setCorrectionsCount(pendingCorrections);
  }
  // Ответы приходят не по порядку: число берётся только из последнего запроса
  const correctionsCountRequest = useRef(0);
  const reloadCorrectionsCount = useCallback(() => {
    const request = ++correctionsCountRequest.current;
    pendingCorrectionsCount(leadMagnetId).then((count) => {
      if (request === correctionsCountRequest.current) setCorrectionsCount(count);
    }, () => {});
  }, [leadMagnetId]);
  const [onConstructorBusy] = useState(() => {
    const watch = watchTurns("constructor");
    return (busy: boolean) => {
      if (!busy) reloadCorrectionsCount();
      watch(busy);
    };
  });
  // «Закончить и разобрать»: просьба ждёт, пока чат конструктора её примет
  const [correctionsRequestQueued, setCorrectionsRequestQueued] = useState(false);
  const [onQueuedRequestSent] = useState(() => () => setCorrectionsRequestQueued(false));
  const constructorComposerActions = useMemo(
    () => correctionsComposerActions(correctionsCount, correctionsRequestQueued, onQueuedRequestSent),
    [correctionsCount, correctionsRequestQueued, onQueuedRequestSent],
  );
  const previewChanges = useRef(0);
  const [previewRevision] = useState(() => () => previewChanges.current);
  const [onPreviewBusy] = useState(() => {
    const watch = watchTurns("preview");
    return (busy: boolean) => {
      if (busy) previewChanges.current++;
      watch(busy);
    };
  });

  // Первая версия создаётся вместе с лидмагнитом; всё, что после неё (конструктор, правка, откат), — собранный черновик
  const hasDraft = versions.length > 1;
  const stageShown = showsStage(draft.flow);

  // Пустой лидмагнит начинают с конструктора: панель открыта сразу. На телефоне она на весь экран, и сохранённое «открыта» её не открывает
  const [panelOpen, setPanelOpen] = useState(() => !hasDraft || (constructorPanelOpen && !onPhone));
  const [consultantModeChosen, setAnsweringAsConsultant] = useState(roleSwapMode);
  // Режим помнится одной кукой на все лидмагниты; у пустого лидмагнита «Поменяемся ролями» нет — там обычный разговор
  const answeringAsConsultant = consultantModeChosen && hasDraft;
  const switchConversationMode = (role: ConversationRole) => {
    const consultant = role === "consultant";
    document.cookie = `${ROLE_SWAP_MODE_COOKIE}=${consultant ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
    setAnsweringAsConsultant(consultant);
  };
  const showPanel = (open: boolean) => {
    document.cookie = `${CONSTRUCTOR_PANEL_COOKIE}=${open ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
    setPanelOpen(open);
  };
  const togglePanel = () => showPanel(!panelOpen);
  // Разговор «Поменяемся ролями» отдан на разбор: конструктор открывается и получает просьбу разобрать правки
  const askConstructorToReview = () => {
    reloadCorrectionsCount();
    showPanel(true);
    setCorrectionsRequestQueued(true);
  };

  // Черновик правит конструктор (или страница ещё подтягивает его правку) — ручные правки и откат закрыты
  const draftLocked = constructorBusy || refreshing;
  // «Сохранить как заготовку» у исправленных ответов «Проверки»: этапы — из сохранённого сценария
  const previewSalesCards = useMemo(
    () => ({
      leadMagnetId,
      states: draft.flow.states.map((state) => ({ id: state.id, title: state.title })),
      locked: draftLocked,
      onSaved: () => router.refresh(),
    }),
    [leadMagnetId, draft.flow.states, draftLocked, router],
  );

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
  // `onDone(true)` — часы сдвинулись; отказ и обрыв связи — `false`, слова о них уже на экране
  const shiftPreview = (shift: () => Promise<{ error?: string }>, failure: string, onDone?: (shifted: boolean) => void) =>
    startShiftDay(async () => {
      previewChanges.current++;
      setNextDayError(null);
      let shifted = false;
      try {
        const { error } = await shift();
        if (error) setNextDayError(error);
        else shifted = true;
      } catch {
        setNextDayError(failure);
      }
      onDone?.(shifted);
      router.refresh();
    });
  const nextDay = () =>
    shiftPreview(() => nextPreviewDayAction(leadMagnetId, browserTimeZone()), "Не получилось перейти к следующему дню. Попробуйте ещё раз.");
  const nextReminder = () =>
    shiftPreview(() => advancePreviewToReminderAction(leadMagnetId, browserTimeZone()), "Не получилось промотать к напоминанию. Попробуйте ещё раз.");
  const rewind = (ms: number) =>
    new Promise<boolean>((resolve) =>
      shiftPreview(() => advancePreviewAction(leadMagnetId, ms, browserTimeZone()), "Не получилось промотать время. Попробуйте ещё раз.", resolve),
    );

  const [reopenError, setReopenError] = useState<string | null>(null);
  const reopen = () =>
    startReopen(async () => {
      previewChanges.current++;
      setReopenError(null);
      try {
        const { error } = await reopenPreviewAction(leadMagnetId);
        if (error) setReopenError(error);
      } catch {
        setReopenError("Не получилось продолжить разговор: нет связи с сервером. Попробуйте ещё раз.");
      }
      router.refresh();
    });
  // Плашка конца — и в «Разговоре», и в тестовом чате доски: это один разговор
  const previewEnd = (chatId: string): PreviewEnd | null =>
    preview.finished && chatId === preview.chatId ? { reopen, reopening, error: reopenError } : null;

  // Лента «Разговора» перечитывается без пересоздания чата (недописанная реплика остаётся в поле): на новом дне и при
  // возврате на вкладку — тот же разговор мог идти в тестовом чате доски
  const [previewFeed, setPreviewFeed] = useState({ day: preview.day, version: 0 });
  if (previewFeed.day !== preview.day) setPreviewFeed({ day: preview.day, version: previewFeed.version + 1 });
  const switchTab = (next: string) => {
    if (next === "preview" && tab !== "preview") setPreviewFeed((current) => ({ ...current, version: current.version + 1 }));
    setTab(next);
  };
  const canGoToNextDay = preview.day !== null && preview.days !== null && preview.day < preview.days;
  const previewClock: PreviewClock = {
    rewind: { onRewind: rewind, onNextReminder: nextReminder, onNextDay: canGoToNextDay ? nextDay : null },
    shifting: shiftingDay,
  };

  // Откат заменяет черновик целиком: несохранённая правка пропала бы молча
  const rollbackBlock = settingsDirty
    ? "Сначала сохраните или отмените правку в «Настройках»"
    : flowDirty
      ? "Сначала сохраните или отмените правку на вкладке «Сценарий»"
      : null;

  const [restartError, setRestartError] = useState<string | null>(null);
  // Проверка начинается с сохранённого черновика: с несохранённой правкой эксперт увидел бы старый текст и решил, что правка не применилась.
  // Подсказка держится, пока правка не сохранена или не отменена
  const [restartBlocked, setRestartBlocked] = useState(false);
  const restartNotice = restartError ?? (restartBlocked && rollbackBlock ? `Проверка идёт по сохранённому черновику. ${rollbackBlock}` : null);
  const restart = () => {
    setRestartError(null);
    setRestartBlocked(Boolean(rollbackBlock));
    if (rollbackBlock) return;
    startRestart(async () => {
      previewChanges.current++;
      setRestartError(null);
      try {
        await restartPreviewAction(leadMagnetId);
        setReopenError(null);
      } catch {
        setRestartError("Не получилось начать проверку заново. Проверьте связь и попробуйте ещё раз.");
      }
      router.refresh();
    });
  };

  // Уход со страницы унёс бы несохранённую правку: сначала вопрос
  const leaveConfirmation = useLeaveConfirmation(settingsDirty ? "в «Настройках»" : flowDirty ? "на вкладке «Сценарий»" : null);

  return (
    <PreviewRevision.Provider value={previewRevision}>
    {/* Редактор занимает окно целиком: data-fill-window растягивает область контента на высоту окна (globals.css) */}
    <Tabs
      value={tab}
      onValueChange={switchTab}
      data-fill-window=""
      className={cn("flex min-h-0 flex-1 flex-col", boardFull ? "gap-0" : "gap-[var(--yk-space-2)] lg:gap-[var(--yk-space-4)]")}
    >
      <header
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 lg:flex-nowrap",
          boardFull ? "px-3 py-1.5" : "",
        )}
      >
        {/* На телефоне название — своя строка, под ним «Публикация» и «Конструктор» по краям одного ряда, ниже вкладки */}
        <h1 className="min-w-0 truncate text-[length:var(--yk-text-body-size)] font-semibold max-lg:basis-full" title={draft.name}>
          {draft.name}
        </h1>
        <DesignButton href={`/lead-magnets/${leadMagnetId}/publish`} variant="secondary" size="sm" className="shrink-0">
          Публикация
        </DesignButton>
        {leaveConfirmation}
        {/* На узком экране вкладки — своя строка во всю ширину, в один ряд: поуже, а не влезут — прокручиваются вбок */}
        <TabsList className="editor-tabs max-lg:order-last max-lg:flex max-lg:w-full max-lg:flex-nowrap max-lg:overflow-x-auto max-lg:[scrollbar-width:none] max-lg:[&>*]:flex-auto max-lg:[&>*]:px-1.5 lg:ml-auto">
          <TabsTrigger value="preview">Разговор</TabsTrigger>
          <TabsTrigger value="flow">Сценарий</TabsTrigger>
          <TabsTrigger value="settings">Настройки</TabsTrigger>
          <TabsTrigger value="history">История</TabsTrigger>
          <TabsTrigger value="log">Лог</TabsTrigger>
        </TabsList>
        <div className="ml-auto flex shrink-0 items-center gap-2 lg:ml-0">
          <DesignButton
            variant={panelOpen ? "primary" : "secondary"}
            size="sm"
            icon={SidebarSimpleIcon}
            aria-pressed={panelOpen}
            aria-controls="constructor-panel"
            title={panelOpen ? "Скрыть конструктор" : "Показать конструктор"}
            onClick={togglePanel}
          >
            Конструктор
          </DesignButton>
        </div>
      </header>
      {/* Панель конструктора сдвигает вкладки, а не ложится поверх: разговор и конструктор видны рядом */}
      <div className={cn("flex min-h-0 flex-1", boardFull ? "gap-0" : "gap-[var(--yk-space-6)]")}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Скрытый «Разговор» остаётся в странице: недописанная реплика не теряется при переходе на другую вкладку */}
            <TabsContent
              value="preview"
              forceMount
              className="flex min-h-0 flex-1 flex-col gap-2 data-[state=inactive]:hidden"
            >
              {/* Над чатом — где клиент сейчас и «Начать заново»; роль, перемотка и конец разговора — в поле ввода, рядом с «Автоответом» */}
              {/* Обычный разговор и разговор «Поменяемся ролями» живут рядом: выбор роли прячет один, не трогая другой */}
              {hasDraft && !answeringAsConsultant ? (
                // Перезапуск нужен и после правки в «Настройках» или «Сценарии»: проверка начнётся с сохранённого черновика
                <ConversationBar onRestart={restart} restarting={restarting || settingsSaving} restartDisabled={settingsSaving}>
                  {preview.day !== null ? (
                    <>
                      <span className="font-medium text-[var(--yk-text)]">
                        День {preview.day}
                        {preview.days !== null ? ` из ${preview.days}` : ""}
                      </span>
                      {stageShown && preview.stageName ? ` · ${preview.stageName}` : null}
                    </>
                  ) : stageShown && preview.stageName ? (
                    `Этап: ${preview.stageName}`
                  ) : null}
                </ConversationBar>
              ) : null}
              {restartNotice && !answeringAsConsultant ? (
                <p role="alert" className="px-3 text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">
                  {restartNotice}
                </p>
              ) : null}
              {nextDayError && !answeringAsConsultant ? (
                <p role="alert" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">
                  {nextDayError}
                </p>
              ) : null}
              <ConversationRoleContext.Provider value={hasDraft ? { role: answeringAsConsultant ? "consultant" : "client", choose: switchConversationMode } : null}>
              {hasDraft ? (
                <div className={cn("min-h-0 flex-1", !answeringAsConsultant && "hidden")}>
                  <RoleSwapPanel leadMagnetId={leadMagnetId} initial={roleSwap} showStage={stageShown} onCorrectionsChanged={reloadCorrectionsCount} onSubmitted={askConstructorToReview} />
                </div>
              ) : null}
              <div className={cn("min-h-0 flex-1", answeringAsConsultant && "hidden")}>
                {hasDraft ? (
                    <PreviewEnd.Provider value={previewEnd(preview.chatId)}>
                      <PreviewClock.Provider value={previewClock}>
                      <ChatLabelsProvider labels={previewLabels}>
                        <PreviewProductLinks.Provider value={{ products: draft.productLinks ?? [], chatId: preview.chatId }}>
                          {/* Разговор завершился или открылся — лента читается заново; новый день и возврат на вкладку —
                              перечитывается без пересоздания чата, чтобы недописанная реплика осталась в поле */}
                          <CorrectablePreviewChat
                            key={`${preview.chatId}:${preview.finished ? "finished" : "open"}`}
                            reloadKey={previewFeed.version}
                            api="/api/preview"
                            chatId={preview.chatId}
                            skin={previewSkin}
                            composerActions={previewComposerActions}
                            videos={videosClient}
                            images={imageLibraryClient}
                            {...(draft.clientImages && { attachments: attachmentsClient })}
                            {...(voiceAvailable && draft.voiceInput && { voice: previewVoice })}
                            noticeLines={flowNoticeLines(flowLabels.notices)}
                            onBusyChange={onPreviewBusy}
                            onCorrectionsChanged={reloadCorrectionsCount}
                            salesCards={previewSalesCards}
                          />
                        </PreviewProductLinks.Provider>
                      </ChatLabelsProvider>
                      </PreviewClock.Provider>
                    </PreviewEnd.Provider>
                ) : (
                  <Alert title="Здесь вы — клиент">
                    Пишите как он и смотрите, как отвечает лидмагнит. Проверка
                    появится, когда конструктор соберёт первый черновик.
                  </Alert>
                )}
              </div>
              </ConversationRoleContext.Provider>
            </TabsContent>

            <TabsContent value="flow" className="flex min-h-0 flex-1 flex-col">
              {overwriteNotice}
              {settingsDirty ? (
                <p role="status" className="px-3 py-1 text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
                  В «Настройках» есть несохранённая правка: она сохранится вместе со сценарием.
                </p>
              ) : null}
              {FlowTab ? (
                <FlowTab
                  leadMagnetId={leadMagnetId}
                  draftVersionId={draftVersionId}
                  value={boardFlow}
                  savedValue={draft.flow}
                  onChange={setBoardFlow}
                  fields={fields}
                  locked={draftLocked}
                  savedSettings={draft}
                  unsavedSettings={settingsEdit}
                  onSaved={(result) => {
                    setBoardSent(result.flow);
                    setSettingsSentWithBoard(settingsEdit && { versionId: result.versionId, settings: settingsEdit });
                    setOverwroteNewerDraft(result.overwroteNewerDraft);
                    router.refresh();
                  }}
                  renderChat={(chatId, { noticeLines }) => (
                      <PreviewEnd.Provider value={previewEnd(chatId)}>
                        <ChatLabelsProvider labels={previewLabels}>
                          <PreviewProductLinks.Provider value={{ products: draft.productLinks ?? [], chatId }}>
                            <CorrectablePreviewChat key={`${chatId}:${previewEnd(chatId) ? "finished" : "open"}`} api="/api/preview" chatId={chatId} skin={previewSkin} composerActions={previewComposerActions} videos={videosClient} images={imageLibraryClient} {...(draft.clientImages && { attachments: attachmentsClient })} {...(voiceAvailable && draft.voiceInput && { voice: previewVoice })} noticeLines={noticeLines} onBusyChange={onPreviewBusy} onCorrectionsChanged={reloadCorrectionsCount} salesCards={previewSalesCards} />
                          </PreviewProductLinks.Provider>
                        </ChatLabelsProvider>
                      </PreviewEnd.Provider>
                    )}
                  onSalesCardsChanged={() => router.refresh()}
                  onPreviewRestarted={() => {
                    router.refresh();
                  }}
                />
              ) : (
                <div role="status" className="flex flex-1 items-center justify-center text-[var(--yk-text-secondary)]">
                  Загружаю доску…
                </div>
              )}
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
              <SettingsTab
                leadMagnetId={leadMagnetId}
                draft={draft}
                draftVersionId={draftVersionId}
                videos={videos}
                images={images}
                knowledge={knowledge}
                modelMenu={modelMenu}
                locked={draftLocked}
                unsavedBoardFlow={flowDirty ? boardFlow : null}
                sentWithBoard={settingsSentWithBoard?.versionId === draftVersionId ? settingsSentWithBoard.settings : null}
                justSaved={savedVersionId === draftVersionId}
                onEditChange={setSettingsEdit}
                onSavingChange={setSettingsSaving}
                onSaved={(result) => {
                  if (flowDirty) setBoardSent(boardFlow);
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
                blockedBecause={rollbackBlock}
                onRolledBack={setOverwroteNewerDraft}
              />
            </TabsContent>

            <TabsContent value="log" className="min-h-0 flex-1 overflow-y-auto">
              <LogTab leadMagnetId={leadMagnetId} />
            </TabsContent>
        </div>
        {/* Закрытая панель остаётся в странице скрытой: чат не теряет историю и начатый ход. На узком экране — на весь экран поверх */}
        <section
          id="constructor-panel"
          aria-label="Конструктор"
          className={cn(
            panelOpen ? "flex" : "hidden",
            "min-h-0 flex-col bg-[var(--yk-surface)]",
            "max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:p-3",
            "lg:w-[440px] lg:shrink-0 lg:border-l lg:border-[var(--yk-border)] lg:pl-[var(--yk-space-6)]",
            boardFull && "lg:py-1.5 lg:pr-3",
          )}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-semibold">Конструктор</span>
            <IconButton label="Закрыть конструктор" icon={XIcon} size="sm" onClick={togglePanel} />
          </div>
          <div className="min-h-0 flex-1">
            <ConstructorSendBlock.Provider value={constructorSendBlock}>
              <ConstructorChatEmpty.Provider value={!constructorStarted}>
                <ChatLabelsProvider labels={hasDraft ? constructorLabels : emptyConstructorLabels}>
                  <AgentChat
                    key={constructorChatId}
                    api="/api/constructor"
                    chatId={constructorChatId}
                    skin={constructorSkin}
                    composerActions={constructorComposerActions}
                    attachments={attachmentsClient}
                    onBusyChange={onConstructorBusy}
                  />
                </ChatLabelsProvider>
              </ConstructorChatEmpty.Provider>
            </ConstructorSendBlock.Provider>
          </div>
        </section>
      </div>
    </Tabs>
    </PreviewRevision.Provider>
  );
}
