import { and, desc, eq, inArray, isNotNull, max, sql, type SQL } from "drizzle-orm";
import { outboundMessages } from "../channels/schema";
import { leadMagnetVersions } from "../lead-magnets/schema";
import { CONTINUABLE_END_STATUSES, snapshotContinues } from "./after-end";
import type { DatabaseExecutor } from "../platform/db";
import { passages, type PassageStatus } from "./schema";
import { afterStartOver } from "./start-over";

/** Брошенный разговор прежнего вида (без «Напоминать») продолжается, если с последнего сообщения в нём прошло меньше недели. */
export const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Снимок нового вида — с «Напоминать» (`nudges.stopAfter`): брошенный разговор открывается снова через сколько угодно.
 * У прежних снимков — неделя, как было.
 */
export function snapshotReopensAnyTime(settings: { flow?: unknown } | null | undefined): boolean {
  const flow = settings?.flow as { nudges?: { stopAfter?: unknown } } | null | undefined;
  return Boolean(flow?.nudges?.stopAfter);
}

export interface LastPassage {
  id: string;
  status: PassageStatus;
  /** Последнее сообщение в разговоре — человека или бота. */
  lastActivityAt: Date;
  /** Снимок разговора велит агенту продолжить его после конца («Агент продолжит разговор»). */
  continuesAfterEnd?: boolean;
  /** Брошенный разговор открывается снова без предела в неделю (`snapshotReopensAnyTime`). */
  reopensAnyTime?: boolean;
}

/**
 * Кто пишет без кода, когда идущего разговора нет. Новичок (у бота с ним не было ни разговора, ни рассылки, и эксперт
 * ему из «Входящих» не отвечал) — режим
 * бота «без кода». Брошенный меньше недели назад разговор, после которого не было ни рассылки, ни ответа эксперта, — тот
 * же разговор. Разговор, законченный согласием или сроком, у снимка которого «Агент продолжит разговор», и после него не
 * было ни рассылки, ни ответа эксперта, — продолжается без ограничения по давности. Остальные — «Входящие».
 */
export type WithoutCodeWriter =
  | { kind: "newcomer" }
  | { kind: "reopen"; passageId: string; anyTime?: true }
  | { kind: "continue"; passageId: string }
  | { kind: "inbox" };

export function whoWritesWithoutCode(input: {
  lastPassage: LastPassage | null;
  lastMailingSentAt: Date | null;
  /**
   * Последний ответ эксперта из «Входящих». Был — переписка идёт с экспертом: вступление лидмагнита посреди неё нелепо,
   * а ответ после брошенного разговора — уже не консультанту.
   */
  lastStaffReplyAt: Date | null;
  now: Date;
}): WithoutCodeWriter {
  const { lastPassage, lastMailingSentAt, lastStaffReplyAt, now } = input;
  if (!lastPassage) return lastMailingSentAt || lastStaffReplyAt ? { kind: "inbox" } : { kind: "newcomer" };
  const recent = lastPassage.reopensAnyTime || now.getTime() - lastPassage.lastActivityAt.getTime() < REOPEN_WINDOW_MS;
  const after = (at: Date | null) => at !== null && at > lastPassage.lastActivityAt;
  if (lastPassage.status === "not_completed" && recent && !after(lastMailingSentAt) && !after(lastStaffReplyAt))
    return { kind: "reopen", passageId: lastPassage.id, ...(lastPassage.reopensAnyTime && { anyTime: true as const }) };
  if (lastPassage.continuesAfterEnd && CONTINUABLE_END_STATUSES.includes(lastPassage.status) && !after(lastMailingSentAt) && !after(lastStaffReplyAt))
    return { kind: "continue", passageId: lastPassage.id };
  return { kind: "inbox" };
}

/**
 * Последний разговор человека, последняя ушедшая ему рассылка и последний ответ эксперта — для `whoWritesWithoutCode`.
 * Записанное до «Начать заново» (`resetAt`) не считается.
 */
export async function loadWithoutCodeHistory(
  tx: DatabaseExecutor,
  personId: string,
  resetAt: Date | null = null,
): Promise<{ lastPassage: LastPassage | null; lastMailingSentAt: Date | null; lastStaffReplyAt: Date | null }> {
  const [passage] = await tx
    .select({
      id: passages.id,
      status: passages.status,
      startedAt: passages.startedAt,
      lastPersonMessageAt: passages.lastPersonMessageAt,
      settings: leadMagnetVersions.settings,
    })
    .from(passages)
    .innerJoin(leadMagnetVersions, eq(leadMagnetVersions.id, passages.snapshotId))
    .where(afterStartOver(passages.startedAt, resetAt, eq(passages.personId, personId)))
    .orderBy(desc(passages.startedAt))
    .limit(1);
  const lastSentTo = async (condition: SQL | undefined) => {
    const [row] = await tx
      .select({ at: max(outboundMessages.sentAt) })
      .from(outboundMessages)
      .where(afterStartOver(outboundMessages.createdAt, resetAt, and(eq(outboundMessages.personId, personId), eq(outboundMessages.status, "sent"), condition)));
    return row?.at ?? null;
  };
  // Проба «Отправить себе» — без рассылки: рассылкой человеку она не считается
  const lastMailingSentAt = await lastSentTo(and(eq(outboundMessages.kind, "mailing"), isNotNull(outboundMessages.mailingId)));
  // Ответ эксперта считается, как только отправлен из «Входящих» (ещё в очереди), — как в контексте консультанта.
  // Ушедший — по времени отправки (часы приложения, как у разговора), ещё в пути — по времени, когда эксперт ответил
  const [staffReply] = await tx
    .select({ at: max(sql<Date>`coalesce(${outboundMessages.sentAt}, ${outboundMessages.createdAt})`).mapWith(outboundMessages.sentAt) })
    .from(outboundMessages)
    .where(
      afterStartOver(
        outboundMessages.createdAt,
        resetAt,
        and(
          eq(outboundMessages.personId, personId),
          eq(outboundMessages.kind, "manual_reply"),
          inArray(outboundMessages.status, ["queued", "sending", "sent"]),
        ),
      ),
    );
  const lastStaffReplyAt = staffReply?.at ?? null;
  if (!passage) return { lastPassage: null, lastMailingSentAt, lastStaffReplyAt };
  const lastBotMessageAt = await lastSentTo(eq(outboundMessages.passageId, passage.id));
  const moments = [passage.lastPersonMessageAt, lastBotMessageAt].filter((at): at is Date => at !== null);
  // Время начала пишет база, а не часы приложения: оно — только если в разговоре не было ни одного сообщения
  const lastActivityAt = moments.length > 0 ? new Date(Math.max(...moments.map((at) => at.getTime()))) : passage.startedAt;
  return {
    lastPassage: {
      id: passage.id,
      status: passage.status,
      lastActivityAt,
      continuesAfterEnd: snapshotContinues(passage.settings),
      reopensAnyTime: snapshotReopensAnyTime(passage.settings),
    },
    lastMailingSentAt,
    lastStaffReplyAt,
  };
}
