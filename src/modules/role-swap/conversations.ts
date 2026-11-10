import { and, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { lockLeadMagnet } from "../lead-magnets";
import type { Database, DatabaseExecutor } from "../platform/db";
import { roleSwapConversations, type RoleSwapAnswerMark, type RoleSwapFinishedReason, type RoleSwapReview } from "./schema";

export type RoleSwapConversation = typeof roleSwapConversations.$inferSelect;

export interface StartConversationInput {
  chatId: string;
  leadMagnetId: string;
  clientBrief: string | null;
  clientCard: string;
  topic: string;
}

const now = sql`clock_timestamp()`;
export const PREVIOUS_CARDS_LIMIT = 5;

/** Новый идущий разговор; прежний текущий разговор лидмагнита получает отметку замены. */
export async function startConversation(db: Database, input: StartConversationInput): Promise<RoleSwapConversation> {
  return db.transaction(async (tx) => {
    await lockLeadMagnet(tx, input.leadMagnetId);
    await tx
      .update(roleSwapConversations)
      .set({ replacedAt: now, updatedAt: now })
      .where(and(eq(roleSwapConversations.leadMagnetId, input.leadMagnetId), isNull(roleSwapConversations.replacedAt)));
    const [row] = await tx.insert(roleSwapConversations).values({ ...input, status: "active" }).returning();
    return row!;
  });
}

export async function currentConversation(db: DatabaseExecutor, leadMagnetId: string): Promise<RoleSwapConversation | null> {
  const [row] = await db
    .select()
    .from(roleSwapConversations)
    .where(and(eq(roleSwapConversations.leadMagnetId, leadMagnetId), isNull(roleSwapConversations.replacedAt)));
  return row ?? null;
}

export async function conversationOfChat(db: DatabaseExecutor, chatId: string): Promise<RoleSwapConversation | null> {
  const [row] = await db.select().from(roleSwapConversations).where(eq(roleSwapConversations.chatId, chatId));
  return row ?? null;
}

/** Отметка реплики эксперта дописывается к прежним. */
export async function markAnswer(db: DatabaseExecutor, chatId: string, messageId: string, mark: RoleSwapAnswerMark): Promise<void> {
  await db
    .update(roleSwapConversations)
    .set({ answerMarks: sql`${roleSwapConversations.answerMarks} || ${JSON.stringify({ [messageId]: mark })}::jsonb`, updatedAt: now })
    .where(eq(roleSwapConversations.chatId, chatId));
}

/** Нода после реплики клиента дописывается к прежним; проверка той же реплики заново заменяет её ноду. */
export async function markClientStage(db: DatabaseExecutor, chatId: string, messageId: string, stageId: string): Promise<void> {
  await db
    .update(roleSwapConversations)
    .set({ clientStages: sql`${roleSwapConversations.clientStages} || ${JSON.stringify({ [messageId]: stageId })}::jsonb`, updatedAt: now })
    .where(eq(roleSwapConversations.chatId, chatId));
}

/** Разговор закончен. Уход клиента после «Закончить и разобрать» отдачу на разбор не отменяет. */
export async function finishConversation(db: DatabaseExecutor, chatId: string, reason: RoleSwapFinishedReason): Promise<void> {
  await db
    .update(roleSwapConversations)
    .set({ status: "finished", finishedReason: reason, updatedAt: now })
    .where(
      and(
        eq(roleSwapConversations.chatId, chatId),
        reason === "submitted" ? undefined : or(isNull(roleSwapConversations.finishedReason), ne(roleSwapConversations.finishedReason, "submitted")),
      ),
    );
}

/**
 * Клиент ушёл на одной ветке, а эксперт правкой своей реплики начал другую: там разговор идёт. Отданный на разбор
 * разговор не трогается.
 */
export async function reopenConversation(db: DatabaseExecutor, chatId: string): Promise<void> {
  await db
    .update(roleSwapConversations)
    .set({ status: "active", finishedReason: null, updatedAt: now })
    .where(and(eq(roleSwapConversations.chatId, chatId), eq(roleSwapConversations.finishedReason, "client_left")));
}

/**
 * «Готовится» без признаков жизни дольше этого — разбор брошен (сервер перезапущен посреди работы). Пока разбор идёт,
 * каждый законченный пробный ход (не дольше минуты) отмечает, что он жив.
 */
export const REVIEW_STALE_MS = 3 * 60_000;

/** Разбор готовится и жив; брошенный «готовится» считается сбоем — нажатие можно повторить. */
export function reviewOf(conversation: Pick<RoleSwapConversation, "review" | "updatedAt">, now = new Date()): RoleSwapReview | null {
  if (conversation.review !== "preparing") return conversation.review;
  return now.getTime() - conversation.updatedAt.getTime() > REVIEW_STALE_MS ? "failed" : "preparing";
}

/** Состояние разбора. `false` — разбор уже готовится и жив: повторное нажатие ничего не начинает. */
export async function setReview(db: DatabaseExecutor, chatId: string, review: RoleSwapReview): Promise<boolean> {
  const rows = await db
    .update(roleSwapConversations)
    .set({ review, updatedAt: now })
    .where(
      and(
        eq(roleSwapConversations.chatId, chatId),
        review === "preparing"
          ? or(
              isNull(roleSwapConversations.review),
              ne(roleSwapConversations.review, "preparing"),
              lt(roleSwapConversations.updatedAt, sql`clock_timestamp() - make_interval(secs => ${REVIEW_STALE_MS / 1000})`),
            )
          : undefined,
      ),
    )
    .returning({ chatId: roleSwapConversations.chatId });
  return rows.length > 0;
}

/** Разбор ещё идёт: отметка жизни для `REVIEW_STALE_MS`. */
export async function touchReview(db: DatabaseExecutor, chatId: string): Promise<void> {
  await db
    .update(roleSwapConversations)
    .set({ updatedAt: now })
    .where(and(eq(roleSwapConversations.chatId, chatId), eq(roleSwapConversations.review, "preparing")));
}

/** Карточки последних разговоров лидмагнита, новые первыми: следующий клиент не повторяет прежних. */
export async function previousCards(db: DatabaseExecutor, leadMagnetId: string, limit = PREVIOUS_CARDS_LIMIT): Promise<string[]> {
  const rows = await db
    .select({ card: roleSwapConversations.clientCard })
    .from(roleSwapConversations)
    .where(eq(roleSwapConversations.leadMagnetId, leadMagnetId))
    .orderBy(desc(roleSwapConversations.createdAt))
    .limit(limit);
  return rows.map((row) => row.card);
}
