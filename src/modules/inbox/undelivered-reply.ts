import { and, desc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import { outboundMessages } from "../channels/schema";
import { inboundMessages, passages } from "../conversations/schema";
import { people } from "../people/schema";
import type { Database, DatabaseExecutor } from "../platform/db";
import { inboxThreads } from "./schema";

/**
 * Ответ эксперта из «Входящих» окончательно не ушёл (окно ответа закрыто, блокировка, сбой): переписка снова ждёт ответа.
 * Неотвеченными считаются сообщения после последнего дошедшего ответа, но не меньше одного — эксперт должен увидеть,
 * что ответ не ушёл. Если следом эксперт ответил ещё раз и тот ответ ушёл или ещё в пути, переписку решает он.
 * Вызывается в транзакции отправки, вместе с записью итога.
 */
export async function reopenAfterUndeliveredReply(
  tx: DatabaseExecutor,
  reply: { id: string; personId: string; createdAt: Date },
): Promise<void> {
  const ofPersonReplies = and(eq(outboundMessages.personId, reply.personId), eq(outboundMessages.kind, "manual_reply"));
  const [later] = await tx
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .where(and(ofPersonReplies, gt(outboundMessages.createdAt, reply.createdAt), inArray(outboundMessages.status, ["queued", "sending", "sent"])))
    .limit(1);
  if (later) return;

  const [delivered] = await tx
    .select({ at: outboundMessages.createdAt })
    .from(outboundMessages)
    .where(and(ofPersonReplies, eq(outboundMessages.status, "sent")))
    .orderBy(desc(outboundMessages.createdAt))
    .limit(1);
  const lastDeliveredAt = delivered?.at ?? null;
  const unanswered = sql<number>`greatest(1, (
    select count(*)::int from ${inboundMessages}
    where ${inboundMessages.personId} = ${reply.personId} and ${inboundMessages.route} = 'inbox'
      and ${inboundMessages.receivedAt} > coalesce(${lastDeliveredAt?.toISOString() ?? null}::timestamptz, '-infinity'::timestamptz)
  ))`;
  await tx.insert(inboxThreads).values({ personId: reply.personId }).onConflictDoNothing();
  await tx
    .update(inboxThreads)
    .set({ unansweredCount: unanswered, lastReplyAt: lastDeliveredAt, lastMessageAt: sql`coalesce(${inboxThreads.lastMessageAt}, ${reply.createdAt.toISOString()}::timestamptz)` })
    .where(eq(inboxThreads.personId, reply.personId));
}

/** Ответ консультанта записан с ключом `turn:<ход>` (`conversations/turn.ts`), а без хода — `turn:<последнее сообщение>`. */
const TURN_ANSWER_KEY_PREFIX = "turn:";

/**
 * Ответ консультанта окончательно не ушёл, а бот исправен — сам он уже не уйдёт. Сообщения, на которые он отвечал, —
 * эксперту во «Входящие», с причиной, как у разговора, переданного эксперту. Разговор не трогаем: следующее сообщение
 * человека — снова консультанту. Повтор ничего не задвоит: перенесённые сообщения уже во «Входящих».
 * Часть ответа успела уйти (`sentParts`) — эксперт видит, что ответ дошёл не целиком, и не повторяет ушедшее.
 */
export async function reopenAfterUndeliveredAnswer(
  db: Database,
  answer: { personId: string; passageId: string | null; idempotencyKey: string; sentParts: number },
  error: string,
  now: Date,
): Promise<void> {
  const turnKey = answer.idempotencyKey.startsWith(TURN_ANSWER_KEY_PREFIX) ? answer.idempotencyKey.slice(TURN_ANSWER_KEY_PREFIX.length) : null;
  await db.transaction(async (tx) => {
    if (answer.passageId && turnKey) {
      // Счётчик и время переписки поднимет триггер базы на смену маршрута
      await tx
        .update(inboundMessages)
        .set({ route: "inbox" })
        .where(
          and(
            eq(inboundMessages.passageId, answer.passageId),
            eq(inboundMessages.route, "passage"),
            isNotNull(inboundMessages.answeredAt),
            or(sql`${inboundMessages.turnId}::text = ${turnKey}`, sql`${inboundMessages.id}::text = ${turnKey}`),
          ),
        );
      await tx
        .update(passages)
        .set({ handedToExpertAt: now, handoverReason: `${answer.sentParts > 0 ? "Ответ консультанта дошёл до человека не целиком" : "Ответ консультанта не дошёл до человека"}: ${error}` })
        .where(eq(passages.id, answer.passageId));
    }
    // Эксперт должен увидеть, что ответ не ушёл, даже если сообщения хода не нашлись. Человека нет — и показывать некому
    await tx
      .insert(inboxThreads)
      .select(
        tx
          .select({
            personId: people.id,
            unansweredCount: sql<number>`1`.as("unanswered_count"),
            lastMessageAt: sql<Date>`${now.toISOString()}::timestamptz`.as("last_message_at"),
            lastReplyAt: sql<Date | null>`null`.as("last_reply_at"),
          })
          .from(people)
          .where(eq(people.id, answer.personId)),
      )
      .onConflictDoUpdate({ target: inboxThreads.personId, set: { unansweredCount: sql`greatest(${inboxThreads.unansweredCount}, 1)` } });
  });
}
