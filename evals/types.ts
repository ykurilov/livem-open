// Что прогон узнал о сценарии: из этого строятся проверки кодом и файлы для судьи.
import type { DialogSummary } from "@/modules/consultant/schema";
import type { LeadMagnetSettings } from "@/modules/lead-magnets";
import type { PersonaRouteReport } from "./persona-model";
import type { Scenario } from "./scenario";

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output?: unknown;
  /** Инструмент упал или вернул ошибку. */
  error?: string;
}

/** Реплика эксперта и ответ конструктора на неё. */
export interface ConstructorTurn {
  expert: string;
  reply: string;
  tools: ToolCallRecord[];
  /** Статус ответа в SDK: `complete`, `error`, `stopped`… */
  status: string;
  error?: string;
  durationMs: number;
}

/** Когда случилось событие по часам стенда: время и дата у человека, у сценария с «Днями и временем» — ещё день сценария. */
export interface EventMoment {
  at: string;
  /** День сценария (`readRun().day`); 0 — вечер позднего старта до первого дня. Без «Дней и времени» — нет. */
  day?: number;
  /** `ЧЧ:ММ` по поясу человека (пока он неизвестен — по Москве). */
  localTime?: string;
  /** `ГГГГ-ММ-ДД` по поясу человека: по этой дате сценарий считает дневной потолок сообщений первым. */
  localDate?: string;
}

/** Что прислал бот: ответ консультанта, сообщение первым, фраза жёсткой рамки дня «Утром отвечу!» или иное служебное. */
export type BotMessageKind = "consultant" | "outreach" | "day_closed" | "other";

export interface TimedBotMessage extends EventMoment {
  kind: BotMessageKind;
  text: string;
}

/** Реплика клиента и всё, что бот прислал в ответ. */
export interface ConsultantTurn {
  /** Что написал клиент; первая реплика — `/start <код>`. */
  client: string;
  /** Сообщения бота клиенту в этом ходе, по порядку (ролик и прощание — отдельными). */
  bot: string[];
  /** Сколько ответов консультанта (исходящих вида `consultant`) появилось за ход. */
  consultantMessages: number;
  tools: ToolCallRecord[];
  /** В этом ходе консультант вызвал finish_dialog. */
  finished: boolean;
  /** Текст, который консультант написал после вызова finish_dialog в том же ответе. */
  textAfterFinish: string | null;
  durationMs: number;
  /** Когда клиент написал; у молчания — когда оно кончилось. */
  sentAt?: EventMoment;
  /** Те же сообщения бота, что в `bot`, со временем и видом. */
  timeline?: TimedBotMessage[];
  /** Клиент не писал, а молчал: «до завтра», «3 ч» или «до конца разговора». Сообщения бота за это время — в `bot`. */
  silence?: string;
}

/** Молчание клиента после разговора: часы стенда идут, пока разговор не кончится сам («не завершил», «срок вышел»). */
export const SILENCE_TILL_END = "до конца разговора";

/**
 * Чем кончился разговор: консультант завершил, клиент ушёл, кончились реплики, приложение закрыло по пределу сообщений,
 * сценарий пришёл в «Итог» мимо finish_dialog, приложение закрыло иначе («не завершил», блокировка), вышел срок программы, сбой.
 */
export type ClientEnd =
  | "consultant_finished"
  | "client_left"
  | "reply_limit"
  | "message_limit"
  | "final_without_finish"
  | "app_closed"
  | "program_ended"
  | "error";

/** Шаг пути по сценарию (`readRun().path`): в какую ноду, откуда, кто решил, почему и в какой день. */
export interface FlowTransitionRecord {
  /** Id ноды. */
  to: string;
  /** Название ноды на доске. */
  title: string;
  from: string | null;
  /** `claim` — заявка агента с судьёй, `judge` — судья после хода, `data`, `event`, `timer`; `start` — начало сценария. */
  decidedBy: string;
  reason: string | null;
  /** День сценария; без «Дней и времени» — `null`. */
  day: number | null;
  at: string;
  tags: string[];
}

/** Где разговор в сценарии к концу прогона. */
export interface ClientFlowRun {
  transitions: FlowTransitionRecord[];
  /** Чем кончился разговор по сценарию: `final`, `deadline`, `abandoned`, `blocked`…; идёт — `null`. */
  endReason: string | null;
}

/** Расход разговора клиента по назначениям журнала SDK, $. */
export interface ClientUsage {
  /** Ответы на сообщения человека. */
  answerUsd: number;
  /** Ходы, где агент пишет первым: касания, утреннее, прощание по сроку. */
  firstMessageUsd: number;
  /** Переписка ответа проверками и поправки расхода. */
  correctionUsd: number;
  /** Судья переходов сценария. */
  judgeUsd: number;
}

export interface ClientRun {
  index: number;
  name: string;
  turns: ConsultantTurn[];
  /** Реплик клиента без `/start`. */
  clientReplies: number;
  endedBy: ClientEnd;
  /** Клиент ушёл посреди разговора, не прощаясь и не отказываясь: консультанту нечего было завершать. */
  leftMidConversation?: boolean;
  passage: {
    status: string;
    summary: DialogSummary | null;
    personMessageCount: number;
    handoverReason: string | null;
  } | null;
  /** Путь по сценарию; нет — разговор не дошёл до сценария или прогон старый. */
  flow?: ClientFlowRun;
  usage?: ClientUsage;
  /** Вся переписка консультанта из хранилища SDK: что видела модель, с вызовами инструментов. */
  chat: StoredChatMessage[];
  /** Короткие ссылки разговора и полные за ними; нет — ссылок с подставленным текстом не было или прогон старый. */
  shortLinks?: { code: string; target: string }[];
  /** Что персонаж клиента сделал не по роли и заметил сам прогон: текст после инструмента выхода, переспрос не по-русски. */
  personaSlips?: string[];
  error?: string;
}

export interface StoredChatMessage {
  role: string;
  status: string;
  parts: unknown[];
}

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

/** `from_file` — лидмагнит взят из файла сценария, конструктор не участвовал. */
export type ExpertEnd = "expert_finished" | "reply_limit" | "from_file" | "error";

export interface ScenarioRun {
  scenario: Scenario;
  startedAt: string;
  durationMs: number;
  building: {
    turns: ConstructorTurn[];
    expertReplies: number;
    endedBy: ExpertEnd;
    error?: string;
    chat: StoredChatMessage[];
    /** Что персонаж эксперта сделал не по роли и заметил сам прогон. */
    personaSlips?: string[];
  };
  /** Черновик лидмагнита после сборки; `null` — не сохранился. */
  settings: LeadMagnetSettings | null;
  publishError: string | null;
  /** Ссылка на политику ПДн из настроек приложения. */
  privacyPolicyUrl: string;
  clients: ClientRun[];
  /** Ошибки моделей и инструментов из журнала агентов. */
  agentLogErrors: string[];
  /** Сбои провайдера, после которых в том же ходе ответил запасной путь: ход дошёл до человека. В старых прогонах нет. */
  agentLogRecovered?: string[];
  /** Сбои самого прогона. */
  runnerErrors: string[];
  /** Модель персонажей и кто на деле им отвечал. В старых прогонах нет. */
  personaRoute?: PersonaRouteReport;
  usage: {
    agents: UsageTotals;
    personas: UsageTotals;
    /** Часть расхода агентов по назначениям: судья, сообщения первым, переписка ответа. В старых прогонах нет. */
    bySource?: { judge: UsageTotals; firstMessage: UsageTotals; answerCorrection: UsageTotals };
  };
}

/** `persona_broke` — персонаж вышел из роли, `stand_broke` — сломан стенд: прогон не годится для оценки агента, это не его провал. */
export type CheckStatus = "pass" | "fail" | "skip" | "persona_broke" | "stand_broke";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** Чей результат: сценарий целиком или клиент. */
  subject: string;
  details: string;
}

export interface ScenarioOutcome {
  run: ScenarioRun;
  checks: CheckResult[];
  /** Номер повтора с 1; нет — прогон без повторов. */
  repeat?: number;
}
