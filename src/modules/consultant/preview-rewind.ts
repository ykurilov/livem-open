import type { loadCurrentBranch, PrepareTurn, PrepareTurnContext } from "@ykurilov/agent-chat-core";
import { testChatOffset } from "@ykurilov/agent-chat-flows";
import { and, eq } from "drizzle-orm";
import { restoreTestBookings, saveTestBookings } from "../booking/test-bookings";
import type { DatabaseExecutor } from "../platform/db";
import { previewConversations, previewTurnSnapshots, type PreviewTurnSnapshot } from "./schema";

// Откат тестового разговора «Проверки» к месту правки. Сценарий SDK своё состояние держит в ветке сообщений: новая
// ветка правки сама несёт прежнюю ноду и счётчики. Вне ветки лежат часы тестового чата и тестовый разговор приложения
// (нода для экрана, факты, поля, продажа, мессенджер, тестовая запись на созвон) — их запоминаем на начало каждого хода и возвращаем при правке.

/** Ключ часов тестового чата в данных чата (`FLOW_TEST_CHAT_KEY` SDK). */
const TEST_CHAT_KEY = "flowTestChat";

export interface PreviewRewind {
  /** Обёртка настроек службы «Проверки»: снимок разговора — до всех подготовок хода. */
  withTurnSnapshots<T extends { agent: { prepareTurn?: PrepareTurn } }>(options: T): T;
  /**
   * Вернуть часы к началу хода ответа `answerId`; разговор — `applyConversation`. Снимка нет — `null`, ничего не тронуто.
   * Разговор как есть запоминается здесь, до всех правок (и до открытия законченного): его возвращает `undo`.
   */
  restore(chatId: string, answerId: string): Promise<RestoredTurn | null>;
}

export interface RestoredTurn {
  /** Записать тестовый разговор как на начало хода; конец разговора снимается. */
  applyConversation(): Promise<void>;
  /** Правка не прошла (сценарий не открылся, служба чата отказала): часы и разговор — как были до отката. */
  undo(): Promise<void>;
}

/** Данные чата (`Chat.data`) тестового разговора: там часы тестового чата SDK. */
export interface PreviewChatData {
  read(chatId: string): Promise<Record<string, unknown>>;
  update(chatId: string, patch: Record<string, unknown>): Promise<void>;
}

type Branch = Awaited<ReturnType<typeof loadCurrentBranch>>;

export function createPreviewRewind({ db, chatData }: { db: DatabaseExecutor; chatData: PreviewChatData }): PreviewRewind {
  async function remember(context: PrepareTurnContext): Promise<void> {
    const [row] = await db.select().from(previewConversations).where(eq(previewConversations.chatId, context.chatId));
    if (!row) return;
    const snapshot: PreviewTurnSnapshot = {
      conversation: {
        currentStageId: row.currentStageId,
        stageHistory: row.stageHistory,
        facts: row.facts,
        fieldValues: row.fieldValues,
        fieldUpdatedAt: row.fieldUpdatedAt,
        timeZone: row.timeZone,
        personMessageCount: row.personMessageCount,
        saleAnswer: row.saleAnswer,
        sideTasks: row.sideTasks,
        messengerChannel: row.messengerChannel,
        messengerOfferedAt: row.messengerOfferedAt?.toISOString() ?? null,
      },
      timeOffset: testChatOffset(context.chat.data),
      callBookings: await saveTestBookings(db, context.chatId),
    };
    await db.insert(previewTurnSnapshots).values({ chatId: context.chatId, answerId: context.messageId, snapshot }).onConflictDoNothing();
  }

  return {
    withTurnSnapshots(options) {
      const prepare = options.agent.prepareTurn;
      const prepareTurn: PrepareTurn = async (context) => {
        // Снимок не должен ронять ход: без него правка просто не откатит разговор
        await remember(context).catch((error: unknown) =>
          console.error(`Снимок хода «Проверки» ${context.chatId}/${context.messageId} не записан:`, error instanceof Error ? error.message : error),
        );
        return prepare?.(context);
      };
      return { ...options, agent: { ...options.agent, prepareTurn } };
    },

    async restore(chatId, answerId) {
      const [found] = await db
        .select({ snapshot: previewTurnSnapshots.snapshot })
        .from(previewTurnSnapshots)
        .where(and(eq(previewTurnSnapshots.chatId, chatId), eq(previewTurnSnapshots.answerId, answerId)));
      if (!found) return null;
      const { conversation, timeOffset, callBookings } = found.snapshot;
      const clockBefore = (await chatData.read(chatId))[TEST_CHAT_KEY];
      const [conversationBefore] = await db.select().from(previewConversations).where(eq(previewConversations.chatId, chatId));
      const bookingsBefore = callBookings ? await saveTestBookings(db, chatId) : null;
      const setClock = async (value: unknown) => {
        if (value !== undefined) await chatData.update(chatId, { [TEST_CHAT_KEY]: value });
      };
      // Часы — первыми: по ним сценарий решает, какой сейчас день и не пора ли написать первым
      if (timeOffset !== null) await setClock({ timeOffset });
      return {
        async undo() {
          if (timeOffset !== null) await setClock(clockBefore);
          if (bookingsBefore) await restoreTestBookings(db, chatId, bookingsBefore);
          if (!conversationBefore) return;
          const { chatId: _chatId, leadMagnetId: _leadMagnetId, createdAt: _createdAt, ...columns } = conversationBefore;
          await db.update(previewConversations).set(columns).where(eq(previewConversations.chatId, chatId));
        },
        async applyConversation() {
          if (callBookings) await restoreTestBookings(db, chatId, callBookings);
          await db
            .update(previewConversations)
            .set({
              ...conversation,
              messengerOfferedAt: conversation.messengerOfferedAt ? new Date(conversation.messengerOfferedAt) : null,
              finishedAt: null,
              summary: null,
            })
            .where(eq(previewConversations.chatId, chatId));
        },
      };
    },
  };
}

/**
 * Ответ агента на ветке ещё идёт (в том числе на другой копии сервера): служба чата правку не примет, а откат до её
 * отказа затёр бы то, что идущий ход пишет в тестовый разговор.
 */
export function answerInProgress(branch: Branch): boolean {
  return branch.some((message) => message.role === "assistant" && message.status === "streaming");
}

/**
 * Ответ, с которого правка переписывает разговор: у правки реплики — первый ответ агента после неё на текущей ветке,
 * у «Переделать ответ» — сам этот ответ. Не нашёлся — `null`.
 */
export function rewoundAnswerId(branch: Branch, request: { editedMessageId?: unknown; messageId?: unknown }): string | null {
  if (typeof request.editedMessageId === "string") {
    const edited = branch.findIndex((message) => message.id === request.editedMessageId);
    if (edited < 0) return null;
    return branch.slice(edited + 1).find((message) => message.role === "assistant")?.id ?? null;
  }
  if (typeof request.messageId === "string") {
    const answer = branch.find((message) => message.id === request.messageId);
    return answer?.role === "assistant" ? answer.id : null;
  }
  return null;
}

/**
 * Сколько реплик человека будет на ветке к ответу этого хода: правка оставляет реплики до правленой и саму правку,
 * «Переделать ответ» — реплики до ответа, новое сообщение добавляет одну.
 */
export function personMessagesForTurn(
  branch: Branch,
  turn: { kind: "messages" | "edit" | "regenerate" | "other"; editedMessageId?: unknown; messageId?: unknown },
): number {
  const people = (messages: Branch) => messages.filter((message) => message.role === "user").length;
  const at = (id: unknown) => branch.findIndex((message) => message.id === id);
  if (turn.kind === "messages") return people(branch) + 1;
  if (turn.kind === "edit" && at(turn.editedMessageId) >= 0) return people(branch.slice(0, at(turn.editedMessageId))) + 1;
  if (turn.kind === "regenerate" && at(turn.messageId) >= 0) return people(branch.slice(0, at(turn.messageId)));
  return people(branch);
}
