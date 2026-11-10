/** Откуда правка: «Проверка» или разговор «Поменяемся ролями»; позже — «Входящие». */
export type CorrectionSource = "preview" | "role_swap";
/**
 * Чью реплику исправили: консультанта или агента-клиента в «Поменяемся ролями». Ответ эксперта за консультанта в этом
 * разговоре — тоже `consultant`: «было» — что ответил бы консультант, «стало» — ответ эксперта.
 */
export type CorrectionAgentRole = "consultant" | "client";
/** `first_message` — первое сообщение лидмагнита, `farewell` — ответ с прощанием приложения: их правят в «Настройках». */
export type AnswerKind = "reply" | "first_message" | "farewell";
export type CorrectionStatus = "pending" | "resolved";
export type CorrectionOutcome = "applied" | "rejected" | "already_covered";

/** Реплика куска разговора перед ответом. `stage` — название ноды, где она прозвучала. */
export interface CorrectionContextLine {
  role: "user" | "assistant";
  text: string;
  stage?: string;
}

export interface AnswerCorrection {
  id: string;
  leadMagnetId: string;
  source: CorrectionSource;
  agentRole: CorrectionAgentRole;
  chatId: string;
  /** Исходный ответ консультанта: ключ «одна неразобранная правка на ответ». */
  originalMessageId: string;
  /** Последний исправленный ответ — сосед исходного. */
  correctedMessageId: string;
  answerKind: AnswerKind;
  /** «Было». */
  originalText: string;
  /** «Стало». */
  correctedText: string;
  /** «Почему так лучше». */
  reason: string | null;
  context: CorrectionContextLine[];
  /** Действия консультанта в ответе понятными словами. */
  actions: string[];
  stageId: string | null;
  programDay: number | null;
  /** Версия черновика, на которой прозвучал ответ. */
  draftVersionId: string;
  status: CorrectionStatus;
  outcome: CorrectionOutcome | null;
  /** Версия, в которой изменение записано (`applied`). */
  resolvedVersionId: string | null;
  resolvedAt: Date | null;
  /** Конструктор упомянул правку эксперту. Повторная правка снимает отметку: «стало» — снова новость. */
  announcedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecordCorrectionInput {
  leadMagnetId: string;
  source: CorrectionSource;
  agentRole: CorrectionAgentRole;
  chatId: string;
  /** Ответ, который правили: исходный ответ консультанта или его прежняя правка. */
  editedMessageId: string;
  /** Текст этого ответа: «было» новой правки. */
  editedText: string;
  /** Новый ответ-сосед с текстом эксперта. */
  correctedMessageId: string;
  correctedText: string;
  reason?: string | null;
  answerKind: AnswerKind;
  context: CorrectionContextLine[];
  actions: string[];
  stageId?: string | null;
  programDay?: number | null;
  draftVersionId: string;
}

/** Ответ эксперта за консультанта в «Поменяемся ролями». */
export interface RoleSwapAnswer {
  /** Реплика эксперта в чате: и исходный, и исправленный ответ записи. */
  messageId: string;
  expertText: string;
  /** Что ответил бы консультант; `null` — посчитать не вышло. */
  consultantText: string | null;
  /** Кусок разговора перед ответом: `user` — клиент, `assistant` — эксперт за консультанта. */
  context: CorrectionContextLine[];
  stageId: string | null;
  draftVersionId: string;
}

export interface RecordRoleSwapAnswersInput {
  leadMagnetId: string;
  chatId: string;
  answers: readonly RoleSwapAnswer[];
}

/**
 * `created` — новая неразобранная правка; `updated` — повторная правка обновила «стало»; `removed` — текст вернули к
 * исходному, правка удалена; `unchanged` — текст не изменился, правки нет.
 */
export type RecordCorrectionResult =
  | { kind: "created" | "updated"; correction: AnswerCorrection }
  | { kind: "removed"; id: string; originalMessageId: string }
  | { kind: "unchanged" };

/** Отказ «Убрать правку»: правки нет у этого лидмагнита или она уже разобрана. */
export type RemoveCorrectionResult = { ok: true; correction: AnswerCorrection } | { ok: false; error: "not_found" | "resolved" };

/**
 * Отказы разбора, всё или ничего: `not_pending` — id не этого лидмагнита или уже разобран; `draft_unchanged` —
 * `applied`, а черновик не менялся после правки.
 */
export type ResolveCorrectionsResult = { ok: true; resolved: number } | { ok: false; error: "not_pending" | "draft_unchanged"; ids: string[] };

/** Отметка исправленного ответа для экрана «Проверки». */
export interface EditedAnswer {
  /** Исправленный ответ, который видно в ленте. */
  messageId: string;
  correctionId: string;
  pending: boolean;
}
