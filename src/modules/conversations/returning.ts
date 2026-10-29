import { and, desc, eq, inArray, max } from "drizzle-orm";
import { outboundMessages } from "../channels/schema";
import type { DatabaseExecutor } from "../platform/db";
import { passages, type PassageStatus } from "./schema";

/** Брошенный разговор продолжается, если с последнего сообщения в нём прошло меньше недели. */
export const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface LastPassage {
  id: string;
  status: PassageStatus;
  /** Последнее сообщение в разговоре — человека или бота. */
  lastActivityAt: Date;
}

/**
 * Кто пишет без кода, когда идущего разговора нет. Новичок (у бота с ним не было ни разговора, ни рассылки, и эксперт
 * ему из «Входящих» не отвечал) — режим
 * бота «без кода». Брошенный меньше недели назад разговор без рассылки после него — тот же разговор. Остальные — «Входящие».
 */
export type WithoutCodeWriter = { kind: "newcomer" } | { kind: "reopen"; passageId: string } | { kind: "inbox" };

export function whoWritesWithoutCode(input: {
  lastPassage: LastPassage | null;
  lastMailingSentAt: Date | null;
  /** Эксперт уже отвечал человеку из «Входящих»: переписка идёт, вступление лидмагнита посреди неё нелепо. */
  staffReplied: boolean;
  now: Date;
}): WithoutCodeWriter {
  const { lastPassage, lastMailingSentAt, staffReplied, now } = input;
  if (!lastPassage) return lastMailingSentAt || staffReplied ? { kind: "inbox" } : { kind: "newcomer" };
  const recent = now.getTime() - lastPassage.lastActivityAt.getTime() < REOPEN_WINDOW_MS;
  const mailedAfter = lastMailingSentAt !== null && lastMailingSentAt > lastPassage.lastActivityAt;
  if (lastPassage.status === "not_completed" && recent && !mailedAfter) return { kind: "reopen", passageId: lastPassage.id };
  return { kind: "inbox" };
}

/** Последний разговор человека и последняя ушедшая ему рассылка — для `whoWritesWithoutCode`. */
export async function loadWithoutCodeHistory(
  tx: DatabaseExecutor,
  personId: string,
): Promise<{ lastPassage: LastPassage | null; lastMailingSentAt: Date | null; staffReplied: boolean }> {
  const [passage] = await tx
    .select({ id: passages.id, status: passages.status, startedAt: passages.startedAt, lastPersonMessageAt: passages.lastPersonMessageAt })
    .from(passages)
    .where(eq(passages.personId, personId))
    .orderBy(desc(passages.startedAt))
    .limit(1);
  const lastSentTo = async (condition: ReturnType<typeof eq>) => {
    const [row] = await tx
      .select({ at: max(outboundMessages.sentAt) })
      .from(outboundMessages)
      .where(and(eq(outboundMessages.personId, personId), eq(outboundMessages.status, "sent"), condition));
    return row?.at ?? null;
  };
  const lastMailingSentAt = await lastSentTo(eq(outboundMessages.kind, "mailing"));
  // Ответ эксперта считается, как только отправлен из «Входящих» (ещё в очереди), — как в контексте консультанта
  const [staffReply] = await tx
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.personId, personId),
        eq(outboundMessages.kind, "manual_reply"),
        inArray(outboundMessages.status, ["queued", "sending", "sent"]),
      ),
    )
    .limit(1);
  const staffReplied = Boolean(staffReply);
  if (!passage) return { lastPassage: null, lastMailingSentAt, staffReplied };
  const lastBotMessageAt = await lastSentTo(eq(outboundMessages.passageId, passage.id));
  const moments = [passage.lastPersonMessageAt, lastBotMessageAt].filter((at): at is Date => at !== null);
  // Время начала пишет база, а не часы приложения: оно — только если в разговоре не было ни одного сообщения
  const lastActivityAt = moments.length > 0 ? new Date(Math.max(...moments.map((at) => at.getTime()))) : passage.startedAt;
  return {
    lastPassage: { id: passage.id, status: passage.status, lastActivityAt },
    lastMailingSentAt,
    staffReplied,
  };
}
