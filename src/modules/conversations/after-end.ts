import { and, desc, eq, inArray } from "drizzle-orm";
import { leadMagnetVersions } from "../lead-magnets/schema";
import type { DatabaseExecutor } from "../platform/db";
import { noteReturnAfterEnd } from "./passage-returns";
import { passages, type PassageStatus } from "./schema";
import { afterStartOver } from "./start-over";

/** Конец, после которого агент может продолжить разговор: согласие (и предел сообщений) или срок программы. */
export const CONTINUABLE_END_STATUSES: readonly PassageStatus[] = ["completed", "term_ended"];

/**
 * Прохождение продолжается после своего конца: человек вернулся, снимок велит агенту продолжить. Ход идёт в законченное
 * прохождение без прощания и без смены итога.
 */
export function continuesAfterEnd(passage: { status: PassageStatus; returnedAfterEndAt: Date | null }): boolean {
  return CONTINUABLE_END_STATUSES.includes(passage.status) && passage.returnedAfterEndAt !== null;
}

/** Снимок лидмагнита велит продолжить разговор с вернувшимся («Агент продолжит разговор»). */
export function snapshotContinues(settings: { returnAfterProgram?: string } | null | undefined): boolean {
  return settings?.returnAfterProgram === "continue";
}

/**
 * Последнее прохождение человека в этом лидмагните закончилось так, что агент его продолжает: согласием или сроком, на
 * снимке с «Агент продолжит разговор». Прохождения до «Начать заново» не считаются. Нет — `null`.
 */
export async function continuableOfLeadMagnet(
  tx: DatabaseExecutor,
  person: { id: string; conversationsResetAt: Date | null },
  leadMagnetId: string,
): Promise<{ id: string } | null> {
  const [last] = await tx
    .select({ id: passages.id, status: passages.status, settings: leadMagnetVersions.settings })
    .from(passages)
    .innerJoin(leadMagnetVersions, eq(leadMagnetVersions.id, passages.snapshotId))
    .where(afterStartOver(passages.startedAt, person.conversationsResetAt, and(eq(passages.personId, person.id), eq(passages.leadMagnetId, leadMagnetId))))
    .orderBy(desc(passages.startedAt))
    .limit(1);
  return last && CONTINUABLE_END_STATUSES.includes(last.status) && snapshotContinues(last.settings) ? { id: last.id } : null;
}

/** Человек вернулся в законченное прохождение: отметка возврата, время его сообщения и возврат для отчёта. */
export async function markReturnedAfterEnd(tx: DatabaseExecutor, passageId: string, now: Date, withMessage: boolean): Promise<void> {
  if (withMessage) await noteReturnAfterEnd(tx, passageId, now);
  await tx
    .update(passages)
    .set({ returnedAfterEndAt: now, ...(withMessage && { lastPersonMessageAt: now }) })
    .where(and(eq(passages.id, passageId), inArray(passages.status, [...CONTINUABLE_END_STATUSES])));
}
