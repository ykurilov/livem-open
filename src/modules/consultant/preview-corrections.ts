import {
  answerEditOf,
  answerText,
  ChatBusyError,
  InvalidMessageError,
  loadCurrentBranch,
  type AnswerEditedInput,
  type ChatService,
  type ChatStorage,
  type StoredMessage,
} from "@ykurilov/agent-chat-core";
import type { FlowRunView } from "@ykurilov/agent-chat-flows";
import {
  answerActions,
  correctionContext,
  draftVersionAt,
  editedAnswersOfChat,
  recordAnswerEdit,
  recordedAnswerEdits,
  removeCorrection,
  type AnswerCorrection,
  type AnswerKind,
  type CorrectionAgentRole,
  type CorrectionSource,
  type EditedAnswer,
} from "../corrections";
import type { LeadMagnet } from "../lead-magnets";
import type { Database } from "../platform/db";

/** «Почему так лучше» длиннее — обрезается: это пояснение, а не второй ответ. */
export const CORRECTION_REASON_MAX_CHARS = 2000;

type AnswerEdit = Omit<AnswerEditedInput, "editedAt">;

export type RemovePreviewCorrectionResult = "removed" | "not_found" | "resolved" | "busy";

export interface PreviewCorrections {
  /** Хук модуля чата: правка ответа консультанта ложится в журнал правок. Повтор с тем же ответом не задваивает. */
  onAnswerEdited(input: AnswerEditedInput): Promise<void>;
  /**
   * Исправленные ответы чата для меток. Сначала дозаписывает правки, которые есть в ленте, но не дошли до журнала:
   * хук повторяется только внутри процесса, и после падения сервера правка могла не записаться.
   */
  editedAnswers(lead: LeadMagnet, chatId: string): Promise<EditedAnswer[]>;
  /** «Убрать правку»: в ленте снова исходный ответ, правка удалена. Только неразобранная и только этого чата. */
  remove(lead: LeadMagnet, chatId: string, correctionId: string): Promise<RemovePreviewCorrectionResult>;
}

export function createPreviewCorrections(deps: {
  db: Database;
  chatStorage: ChatStorage;
  /** Лидмагнит тестового чата, в том числе прежнего, после «Начать проверку заново». */
  leadOfChat(chatId: string): Promise<LeadMagnet>;
  readRun(ownerId: string, chatId: string): Promise<FlowRunView | null>;
  serviceOfChat(chatId: string): Promise<ChatService>;
  /**
   * Чьи ответы правят; по умолчанию — консультанта в «Проверке». Агент-клиент «Поменяемся ролями»: кусок разговора —
   * глазами консультанта (реплики эксперта — `assistant`), вид ответа — всегда `reply`, действий и места в сценарии нет.
   */
  kind?: { source: CorrectionSource; agentRole: CorrectionAgentRole };
}): PreviewCorrections {
  const { db, chatStorage } = deps;
  const kind = deps.kind ?? { source: "preview", agentRole: "consultant" };
  const forClient = kind.agentRole === "client";

  async function record(lead: LeadMagnet, edit: AnswerEdit, messages: readonly StoredMessage[]): Promise<void> {
    const byId = new Map(messages.map((message) => [message.id, message]));
    const corrected = byId.get(edit.messageId);
    const source = byId.get(edit.sourceMessageId);
    if (!corrected || !source) throw new Error(`Правка ${edit.messageId} чата ${edit.chatId}: нет ответа в ленте`);
    const lineage = editLineage(source, byId);
    const original = lineage.at(-1)!;
    const place = forClient ? null : await placeOfAnswer(edit, corrected.id, new Set([corrected.id, ...lineage.map((message) => message.id)]));
    const path = pathTo(corrected, byId);
    // Хук и сверка после падения пишут одну версию — ту, на которой прозвучал ответ
    const draftVersionId = (await draftVersionAt(db, lead.id, new Date(original.createdAt))) ?? lead.draftVersionId;
    await recordAnswerEdit(db, edit.messageId, {
      leadMagnetId: lead.id,
      ...kind,
      chatId: edit.chatId,
      editedMessageId: edit.sourceMessageId,
      editedText: edit.sourceText,
      correctedMessageId: edit.messageId,
      correctedText: edit.text,
      reason: reasonOf(edit.data),
      answerKind: forClient ? "reply" : answerKindOf(original, lead.draft.farewellMessage),
      context: correctionContext(forClient ? path.map(asConsultantSees) : path, corrected.id),
      actions: forClient ? [] : answerActions(source.parts),
      stageId: place?.stageId ?? null,
      programDay: place?.day ?? null,
      draftVersionId,
    });
  }

  /**
   * Нода и день, где начался ответ. Известны, только пока ответ последний в ленте: место чата — текущее, а нода, в
   * которую вошли на этом ответе, — уже следующая. У старого ответа места нет: чужая нода сбила бы конструктор.
   */
  async function placeOfAnswer(edit: AnswerEdit, answerId: string, sameAnswer: ReadonlySet<string>): Promise<{ stageId: string; day: number | null } | null> {
    const branch = await loadCurrentBranch(chatStorage, edit.chatId);
    const index = branch.findIndex((message) => message.id === answerId);
    if (index < 0 || branch.slice(index + 1).some((message) => answerText(message.parts).trim())) return null;
    const run = await deps.readRun(edit.ownerId, edit.chatId);
    if (!run) return null;
    const enteredOnThisAnswer = run.enteredAfterAnswer !== undefined && sameAnswer.has(run.enteredAfterAnswer);
    return {
      stageId: (enteredOnThisAnswer ? run.path.at(-1)?.from : null) ?? run.state,
      day: run.day ? Math.max(1, run.day.day) : null,
    };
  }

  async function reconcile(lead: LeadMagnet, chatId: string): Promise<void> {
    const [messages, recorded, chat] = await Promise.all([chatStorage.listMessages(chatId), recordedAnswerEdits(db, chatId), chatStorage.getChat(chatId)]);
    if (!chat) return;
    const byId = new Map(messages.map((message) => [message.id, message]));
    const missing = messages
      .flatMap((message) => {
        const edit = answerEditOf(message.parts);
        // Запись в ленте — только от владельца этого чата
        return edit && edit.ownerId === chat.ownerId && !recorded.has(message.id) ? [{ message, edit }] : [];
      })
      .sort((a, b) => a.edit.editedAt.localeCompare(b.edit.editedAt));
    for (const { message, edit } of missing) {
      const source = byId.get(edit.sourceMessageId);
      if (!source) continue;
      // Сбой одной правки не лишает эксперта меток: она дозапишется при следующем чтении
      try {
        await record(
          lead,
          {
            ownerId: edit.ownerId,
            chatId,
            sourceMessageId: edit.sourceMessageId,
            messageId: message.id,
            sourceText: answerText(source.parts),
            text: answerText(message.parts),
            ...(edit.data && { data: edit.data }),
          },
          messages,
        );
      } catch (error) {
        console.error(`Правка ${message.id} чата ${chatId} не дозаписана:`, error instanceof Error ? error.message : error);
      }
    }
  }

  return {
    async onAnswerEdited(input) {
      const lead = await deps.leadOfChat(input.chatId);
      await record(lead, input, await chatStorage.listMessages(input.chatId));
    },

    async editedAnswers(lead, chatId) {
      await reconcile(lead, chatId);
      return editedAnswersOfChat(db, chatId, kind.agentRole);
    },

    async remove(lead, chatId, correctionId) {
      if (!(await editedAnswersOfChat(db, chatId, kind.agentRole)).some((edited) => edited.correctionId === correctionId)) return "not_found";
      const [chat, messages] = await Promise.all([chatStorage.getChat(chatId), chatStorage.listMessages(chatId)]);
      try {
        // Ответ возвращается в ленту под блокировкой лидмагнита: разбор не отметит правку, пока лента переключается
        const removed = await removeCorrection(db, lead.id, correctionId, async (correction) => {
          if (!chat) return;
          try {
            await (await deps.serviceOfChat(chatId)).selectBranch(chat.ownerId, chatId, answerBeforeCorrection(correction, messages));
          } catch (error) {
            // Исправленный ответ уже не на текущей ветке — переключать нечего
            if (!(error instanceof InvalidMessageError)) throw error;
          }
        });
        return removed.ok ? "removed" : removed.error;
      } catch (error) {
        if (error instanceof ChatBusyError) return "busy";
        throw error;
      }
    },
  };
}

/** Ответ, который правили, и все ответы, правкой которых он стал, — до исходного ответа консультанта (последний). */
function editLineage(source: StoredMessage, byId: ReadonlyMap<string, StoredMessage>): StoredMessage[] {
  const lineage = [source];
  for (let edit = answerEditOf(source.parts); edit; ) {
    const earlier = byId.get(edit.sourceMessageId);
    if (!earlier || lineage.includes(earlier)) break;
    lineage.push(earlier);
    edit = answerEditOf(earlier.parts);
  }
  return lineage;
}

/**
 * Ответ, к которому возвращает «Убрать правку», — с текстом «было» этой правки. После разбора правки «было» новой правки —
 * уже принятый исправленный ответ, а не самый первый ответ консультанта.
 */
function answerBeforeCorrection(correction: AnswerCorrection, messages: readonly StoredMessage[]): string {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const corrected = byId.get(correction.correctedMessageId);
  const earlier = corrected ? editLineage(corrected, byId).slice(1) : [];
  return earlier.find((message) => answerText(message.parts) === correction.originalText)?.id ?? correction.originalMessageId;
}

/** Разговор от начала до ответа — по ветке этого ответа, а не по текущей. */
function pathTo(message: StoredMessage, byId: ReadonlyMap<string, StoredMessage>): StoredMessage[] {
  const path = [message];
  for (let parent = message.parentId && byId.get(message.parentId); parent && !path.includes(parent); parent = parent.parentId && byId.get(parent.parentId))
    path.unshift(parent);
  return path;
}

/** В чате «Поменяемся ролями» агент — клиент, а эксперт пишет за консультанта: для журнала роли меняются местами. */
function asConsultantSees(message: StoredMessage): StoredMessage {
  return { ...message, role: message.role === "user" ? "assistant" : "user" };
}

/** Первое сообщение лидмагнита — начало ленты; ответ с прощанием приложения кончается им. */
function answerKindOf(original: StoredMessage, farewellMessage: string): AnswerKind {
  if (original.parentId === null) return "first_message";
  const farewell = farewellMessage.trim();
  return farewell && answerText(original.parts).trimEnd().endsWith(farewell) ? "farewell" : "reply";
}

function reasonOf(data: Record<string, unknown> | undefined): string | null {
  const reason = typeof data?.reason === "string" ? data.reason.trim().slice(0, CORRECTION_REASON_MAX_CHARS) : "";
  return reason || null;
}
