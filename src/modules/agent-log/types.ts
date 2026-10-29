/** Чей ход: конструктор собирает лидмагнит, консультант разговаривает. */
export type AgentLogAgent = "constructor" | "consultant";
/** Откуда разговор консультанта: «Проверка» в редакторе или мессенджер. У конструктора — `null`. */
export type AgentLogSource = "preview" | "messenger";

/** Часть сообщения в запросе к модели — в виде для чтения человеком. */
export type LoggedPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; output: unknown }
  | { type: "file"; mediaType: string };

export interface LoggedMessage {
  role: "user" | "assistant" | "tool" | "system";
  parts: LoggedPart[];
}

export interface LoggedUsage {
  input?: number;
  output?: number;
  /** Вход, прочитанный из кэша модели. */
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/** Вызов языковой модели. */
export interface ModelCallEntry {
  kind: "model";
  at: string;
  durationMs: number;
  providerId: string;
  modelId: string;
  request: {
    /** Инструкция — только у первого вызова хода: дальше она та же. */
    instructions?: string;
    /** Только новое: у первого вызова хода — с последнего ответа агента, дальше — то, что добавилось после прошлого вызова. */
    messages: LoggedMessage[];
    /** Сколько сообщений начала запроса не записано (история до хода, прошлые шаги хода). */
    earlierMessages: number;
  };
  response: {
    text: string;
    reasoning?: string;
    toolCalls: Array<{ id: string; name: string; input: unknown }>;
    finishReason?: string;
  };
  usage?: LoggedUsage;
  error?: string;
}

/** Вызов инструмента агента. */
export interface ToolCallEntry {
  kind: "tool";
  at: string;
  durationMs: number;
  toolCallId?: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

/** Кто решил переход между нодами (`decidedBy` SDK): агент с судьёй, судья после ответа, данные, событие, таймер. */
export type TransitionDecider = "claim" | "judge" | "data" | "event" | "timer";

/** Переход сценария из ноды в ноду: откуда, куда, кто решил, почему, какой день. Названия нод — на момент перехода. */
export interface FlowTransitionEntry {
  kind: "transition";
  at: string;
  durationMs: number;
  from: string;
  to: string;
  decidedBy: TransitionDecider;
  /** Причина словами: объяснение агента или условие («нода длится 1 день», «срок вышел»). */
  reason: string | null;
  /** Уверенность судьи, 0…1. */
  probability?: number;
  day?: number;
  totalDays?: number;
  /** Переход «назад», в ту ноду, откуда ушли на попутное. */
  returned?: boolean;
}

/** Почему бот написал первым (`firstReasons` SDK); название ноды — для перехода по сроку. */
export type FirstMessageReason =
  | { kind: "transition"; stateTitle: string }
  | { kind: "morning" }
  | { kind: "silence"; step: number }
  | { kind: "daily"; at: string }
  | { kind: "night_messages"; count: number }
  | { kind: "farewell" };

/** Бот пишет первым: причины одного срока, собранные в один ход. */
export interface FirstMessageEntry {
  kind: "first-message";
  at: string;
  durationMs: number;
  reasons: FirstMessageReason[];
}

/** Откуда и куда перевели разговоры: версия и нода до перевода → нода новой версии. Названия — на момент перевода. */
export interface ChatMigrationMove {
  fromVersionId: string;
  fromVersionAt: string;
  from: string;
  to: string;
  chats: number;
}

/** Эксперт перевёл идущие разговоры на новую версию лидмагнита: кто, сколько, откуда и куда. */
export interface ChatMigrationEntry {
  kind: "migration";
  at: string;
  durationMs: number;
  /** Кто перевёл: «Имя (почта)» или почта. */
  by: string;
  chats: number;
  toVersionId: string;
  toVersionAt: string;
  moves: ChatMigrationMove[];
}

export type AgentLogEntry = ModelCallEntry | ToolCallEntry | FlowTransitionEntry | FirstMessageEntry | ChatMigrationEntry;

/** Куда перехват отдаёт записи. Не ждёт записи и не бросает наружу: ход агента журнал не тормозит. */
export interface AgentLogSink {
  startTurn(turn: { id: string; chatId: string; startedAt: string }): void;
  addEntry(turnId: string, entry: AgentLogEntry): void;
}

/** Ход в журнале для экрана. */
export interface AgentLogTurn {
  id: string;
  agent: AgentLogAgent;
  source: AgentLogSource | null;
  /** Человек в мессенджере: имя или id в мессенджере. */
  personLabel: string | null;
  channel: string | null;
  startedAt: string;
  entries: AgentLogEntry[];
}

export interface AgentLogPage {
  turns: AgentLogTurn[];
  /** Курсор следующей порции (более старые ходы); `null` — больше нет. */
  nextBefore: string | null;
}
