import { and, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import type { DatabaseExecutor } from "../platform/db";
import { inboundMessages, passages, type PassageStatus } from "./schema";

export type PassageEndStatus = Exclude<PassageStatus, "active">;

/**
 * Закрывает идущие прохождения из условия `which`: итог, время конца, напоминаний больше нет. Уже закрытые не трогает.
 * Сообщения, отложенные до утра жёсткой рамкой дня, утром уже никто не ответит — они уходят эксперту во «Входящие».
 */
export async function endActivePassages(tx: DatabaseExecutor, which: SQL, status: PassageEndStatus, at: Date): Promise<void> {
  const ended = await tx
    .update(passages)
    .set({ status, endedAt: at, nextReminderAt: null })
    .where(and(which, eq(passages.status, "active")))
    .returning({ id: passages.id });
  if (ended.length === 0) return;
  await tx
    .update(inboundMessages)
    .set({ route: "inbox", heldAt: null })
    .where(and(inArray(inboundMessages.passageId, ended.map((passage) => passage.id)), isNotNull(inboundMessages.heldAt)));
}

/** Бот ответил человеку в разговоре: отложенные до утра сообщения больше не ждут. */
export async function releaseHeldMessages(tx: DatabaseExecutor, passageId: string): Promise<void> {
  await tx
    .update(inboundMessages)
    .set({ heldAt: null })
    .where(and(eq(inboundMessages.passageId, passageId), isNotNull(inboundMessages.heldAt)));
}
