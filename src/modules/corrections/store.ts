import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { lockLeadMagnet } from "../lead-magnets";
import { leadMagnetVersions } from "../lead-magnets/schema";
import type { Database, DatabaseExecutor } from "../platform/db";
import { answerCorrections, answerEditReceipts } from "./schema";
import type {
  AnswerCorrection,
  CorrectionAgentRole,
  CorrectionOutcome,
  CorrectionStatus,
  EditedAnswer,
  RecordCorrectionInput,
  RecordCorrectionResult,
  RecordRoleSwapAnswersInput,
  RemoveCorrectionResult,
  ResolveCorrectionsResult,
} from "./types";

type CorrectionRow = typeof answerCorrections.$inferSelect;

export function toAnswerCorrection(row: CorrectionRow): AnswerCorrection {
  return { ...row };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const now = sql`clock_timestamp()`;
const blankToNull = (text: string | null | undefined) => (text?.trim() ? text.trim() : null);

/**
 * Правка ответа. Неразобранная правка того же ответа (по исправленному или исходному ответу) получает новое «стало»;
 * текст вернули к исходному — правка удаляется. Правка разобранной правки — новая неразобранная того же исходного ответа.
 * Правки одного лидмагнита пишутся по очереди (строка лидмагнита блокируется).
 */
export async function recordCorrection(db: Database, input: RecordCorrectionInput): Promise<RecordCorrectionResult> {
  return db.transaction(async (tx) => {
    await lockLeadMagnet(tx, input.leadMagnetId);
    return recordLocked(tx, input);
  });
}

/**
 * Правка ответа из модуля чата: `messageId` — ответ с текстом эксперта. Каждый такой ответ учитывается один раз —
 * повтор хука и сверка с лентой чата его не задваивают, а убранную правку не возвращают (`already_recorded`).
 */
export async function recordAnswerEdit(
  db: Database,
  messageId: string,
  input: RecordCorrectionInput,
): Promise<RecordCorrectionResult | { kind: "already_recorded" }> {
  return db.transaction(async (tx) => {
    await lockLeadMagnet(tx, input.leadMagnetId);
    const [receipt] = await tx
      .insert(answerEditReceipts)
      .values({ messageId, leadMagnetId: input.leadMagnetId, chatId: input.chatId })
      .onConflictDoNothing()
      .returning({ messageId: answerEditReceipts.messageId });
    if (!receipt) return { kind: "already_recorded" };
    return recordLocked(tx, input);
  });
}

/** Ответы чата с текстом эксперта, уже учтённые журналом правок. */
export async function recordedAnswerEdits(db: DatabaseExecutor, chatId: string): Promise<Set<string>> {
  const rows = await db.select({ messageId: answerEditReceipts.messageId }).from(answerEditReceipts).where(eq(answerEditReceipts.chatId, chatId));
  return new Set(rows.map((row) => row.messageId));
}

async function recordLocked(tx: DatabaseExecutor, input: RecordCorrectionInput): Promise<RecordCorrectionResult> {
  const reason = blankToNull(input.reason);
  const [pending] = await tx
    .select()
    .from(answerCorrections)
    .where(
      and(
        eq(answerCorrections.leadMagnetId, input.leadMagnetId),
        eq(answerCorrections.status, "pending"),
        or(eq(answerCorrections.correctedMessageId, input.editedMessageId), eq(answerCorrections.originalMessageId, input.editedMessageId)),
      ),
    );

  if (pending) {
    if (input.correctedText === pending.originalText) {
      await tx.delete(answerCorrections).where(eq(answerCorrections.id, pending.id));
      return { kind: "removed", id: pending.id, originalMessageId: pending.originalMessageId };
    }
    const [updated] = await tx
      .update(answerCorrections)
      .set({
        correctedMessageId: input.correctedMessageId,
        correctedText: input.correctedText,
        reason: reason ?? pending.reason,
        announcedAt: null,
        updatedAt: now,
      })
      .where(eq(answerCorrections.id, pending.id))
      .returning();
    return { kind: "updated", correction: toAnswerCorrection(updated!) };
  }

  if (input.correctedText === input.editedText) return { kind: "unchanged" };
  const [earlier] = await tx
    .select({ originalMessageId: answerCorrections.originalMessageId })
    .from(answerCorrections)
    .where(and(eq(answerCorrections.leadMagnetId, input.leadMagnetId), eq(answerCorrections.correctedMessageId, input.editedMessageId)))
    .limit(1);
  const [created] = await tx
    .insert(answerCorrections)
    .values({
      leadMagnetId: input.leadMagnetId,
      source: input.source,
      agentRole: input.agentRole,
      chatId: input.chatId,
      originalMessageId: earlier?.originalMessageId ?? input.editedMessageId,
      correctedMessageId: input.correctedMessageId,
      answerKind: input.answerKind,
      originalText: input.editedText,
      correctedText: input.correctedText,
      reason,
      context: input.context,
      actions: input.actions,
      stageId: input.stageId ?? null,
      programDay: input.programDay ?? null,
      draftVersionId: input.draftVersionId,
      status: "pending",
    })
    .returning();
  return { kind: "created", correction: toAnswerCorrection(created!) };
}

/**
 * Ответы эксперта за консультанта из «Поменяемся ролями» — неразобранными записями, всё или ничего. Ответ, у которого
 * уже есть неразобранная запись, пропускается: повторная отдача на разбор ничего не задваивает. Итог — число новых записей.
 */
export async function recordRoleSwapAnswers(db: Database, input: RecordRoleSwapAnswersInput): Promise<number> {
  if (input.answers.length === 0) return 0;
  return db.transaction(async (tx) => {
    await lockLeadMagnet(tx, input.leadMagnetId);
    const ids = input.answers.map((answer) => answer.messageId);
    const known = await tx
      .select({ messageId: answerCorrections.originalMessageId })
      .from(answerCorrections)
      .where(and(eq(answerCorrections.status, "pending"), inArray(answerCorrections.originalMessageId, ids)));
    const skip = new Set(known.map((row) => row.messageId));
    const fresh = input.answers.filter((answer, index) => !skip.has(answer.messageId) && ids.indexOf(answer.messageId) === index);
    // По одной: у записей одной отдачи разное время, порядок разговора сохраняется
    for (const answer of fresh)
      await tx.insert(answerCorrections).values({
        leadMagnetId: input.leadMagnetId,
        source: "role_swap",
        agentRole: "consultant",
        chatId: input.chatId,
        originalMessageId: answer.messageId,
        correctedMessageId: answer.messageId,
        answerKind: "reply",
        originalText: answer.consultantText ?? "",
        correctedText: answer.expertText,
        reason: null,
        context: answer.context,
        actions: [],
        stageId: answer.stageId,
        draftVersionId: answer.draftVersionId,
        status: "pending",
      });
    return fresh.length;
  });
}

/**
 * «Убрать правку»: только неразобранную. Отдаёт удалённую правку. `beforeDelete` идёт под блокировкой лидмагнита —
 * разбор правки ждёт его; ошибка в нём оставляет правку на месте.
 */
export async function removeCorrection(
  db: Database,
  leadMagnetId: string,
  id: string,
  beforeDelete?: (correction: AnswerCorrection) => Promise<void>,
): Promise<RemoveCorrectionResult> {
  if (!UUID.test(id)) return { ok: false, error: "not_found" };
  return db.transaction(async (tx) => {
    await lockLeadMagnet(tx, leadMagnetId);
    const [row] = await tx
      .select()
      .from(answerCorrections)
      .where(and(eq(answerCorrections.id, id), eq(answerCorrections.leadMagnetId, leadMagnetId)));
    if (!row) return { ok: false, error: "not_found" };
    if (row.status !== "pending") return { ok: false, error: "resolved" };
    await beforeDelete?.(toAnswerCorrection(row));
    await tx.delete(answerCorrections).where(eq(answerCorrections.id, id));
    return { ok: true, correction: toAnswerCorrection(row) };
  });
}

/** Правки лидмагнита по порядку появления; по умолчанию — неразобранные. */
export async function listCorrections(
  db: DatabaseExecutor,
  leadMagnetId: string,
  options: { status?: CorrectionStatus | "all" } = {},
): Promise<AnswerCorrection[]> {
  const status = options.status ?? "pending";
  const rows = await db
    .select()
    .from(answerCorrections)
    .where(and(eq(answerCorrections.leadMagnetId, leadMagnetId), status === "all" ? undefined : eq(answerCorrections.status, status)))
    .orderBy(asc(answerCorrections.createdAt), asc(answerCorrections.id));
  return rows.map(toAnswerCorrection);
}

/** Правка лидмагнита по id; чужая или удалённая — `null`. */
export async function getCorrection(db: DatabaseExecutor, leadMagnetId: string, id: string): Promise<AnswerCorrection | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db
    .select()
    .from(answerCorrections)
    .where(and(eq(answerCorrections.id, id), eq(answerCorrections.leadMagnetId, leadMagnetId)));
  return row ? toAnswerCorrection(row) : null;
}

export async function countPending(db: DatabaseExecutor, leadMagnetId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(answerCorrections)
    .where(and(eq(answerCorrections.leadMagnetId, leadMagnetId), eq(answerCorrections.status, "pending")));
  return row?.count ?? 0;
}

/**
 * Исправленные ответы агента `agentRole` в чате — для метки «Исправлено» и кнопки «Убрать правку» (только у
 * неразобранных). Ответы эксперта, отданные на разбор из «Поменяемся ролями», правками в ленте не считаются.
 */
export async function editedAnswersOfChat(db: DatabaseExecutor, chatId: string, agentRole: CorrectionAgentRole): Promise<EditedAnswer[]> {
  const rows = await db
    .select({ messageId: answerCorrections.correctedMessageId, correctionId: answerCorrections.id, status: answerCorrections.status })
    .from(answerCorrections)
    .where(and(eq(answerCorrections.chatId, chatId), eq(answerCorrections.agentRole, agentRole)))
    .orderBy(asc(answerCorrections.createdAt), asc(answerCorrections.id));
  return rows.map(({ messageId, correctionId, status }) => ({ messageId, correctionId, pending: status === "pending" }));
}

/**
 * Неразобранные правки, о которых конструктор ещё не говорил эксперту, и сколько всего неразобранных. `seenAt` — время
 * базы на момент чтения: правку, исправленную позже, `markAnnounced` не отметит.
 */
export async function unannounced(db: DatabaseExecutor, leadMagnetId: string): Promise<{ ids: string[]; pendingTotal: number; seenAt: Date }> {
  const { rows: clock } = await db.execute<{ at: string }>(sql`select clock_timestamp() as at`);
  const rows = await db
    .select({ id: answerCorrections.id, announcedAt: answerCorrections.announcedAt })
    .from(answerCorrections)
    .where(and(eq(answerCorrections.leadMagnetId, leadMagnetId), eq(answerCorrections.status, "pending")))
    .orderBy(asc(answerCorrections.createdAt), asc(answerCorrections.id));
  return { ids: rows.filter((row) => row.announcedAt === null).map((row) => row.id), pendingTotal: rows.length, seenAt: new Date(clock[0]!.at) };
}

/** Конструктор упомянул правки: после удачного хода, в хвосте которого они были, — только не исправленные после `seenAt`. */
export async function markAnnounced(db: DatabaseExecutor, ids: readonly string[], seenAt: Date): Promise<void> {
  const valid = ids.filter((id) => UUID.test(id));
  if (valid.length === 0) return;
  await db
    .update(answerCorrections)
    .set({ announcedAt: now })
    .where(and(inArray(answerCorrections.id, valid), isNull(answerCorrections.announcedAt), lte(answerCorrections.updatedAt, seenAt)));
}

/** Версия черновика, которая была текущей в момент `at`: на ней прозвучал ответ. */
export async function draftVersionAt(db: DatabaseExecutor, leadMagnetId: string, at: Date): Promise<string | null> {
  const [row] = await db
    .select({ id: leadMagnetVersions.id })
    .from(leadMagnetVersions)
    .where(and(eq(leadMagnetVersions.leadMagnetId, leadMagnetId), lte(leadMagnetVersions.createdAt, at)))
    .orderBy(desc(leadMagnetVersions.createdAt))
    .limit(1);
  return row?.id ?? null;
}

const answeredVersion = alias(leadMagnetVersions, "answered_version");

/**
 * Итог разбора, всё или ничего. `applied` — только если текущая версия черновика записана позже и версии, на которой
 * прозвучал ответ, и последней правки: так «учтено» не отметить без записи изменения. Её id ложится в правку.
 */
export async function resolveCorrections(
  db: Database,
  leadMagnetId: string,
  ids: readonly string[],
  outcome: CorrectionOutcome,
): Promise<ResolveCorrectionsResult> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return { ok: true, resolved: 0 };
  return db.transaction(async (tx) => {
    const lead = await lockLeadMagnet(tx, leadMagnetId);
    const currentAt = sql`(select ${leadMagnetVersions.createdAt} from ${leadMagnetVersions} where ${leadMagnetVersions.id} = ${lead.draftVersionId})`;
    const valid = wanted.filter((id) => UUID.test(id));
    const rows =
      valid.length === 0
        ? []
        : await tx
            .select({
              id: answerCorrections.id,
              draftChanged: sql<boolean>`coalesce(${currentAt} > greatest(${answeredVersion.createdAt}, ${answerCorrections.updatedAt}), false)`,
            })
            .from(answerCorrections)
            .leftJoin(answeredVersion, eq(answeredVersion.id, answerCorrections.draftVersionId))
            .where(and(eq(answerCorrections.leadMagnetId, leadMagnetId), eq(answerCorrections.status, "pending"), inArray(answerCorrections.id, valid)));

    const found = new Set(rows.map((row) => row.id));
    const missing = wanted.filter((id) => !found.has(id));
    if (missing.length > 0) return { ok: false, error: "not_pending", ids: missing };
    if (outcome === "applied") {
      const stale = rows.filter((row) => !row.draftChanged).map((row) => row.id);
      if (stale.length > 0) return { ok: false, error: "draft_unchanged", ids: wanted.filter((id) => stale.includes(id)) };
    }

    await tx
      .update(answerCorrections)
      .set({
        status: "resolved",
        outcome,
        resolvedVersionId: outcome === "applied" ? lead.draftVersionId : null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(inArray(answerCorrections.id, wanted));
    return { ok: true, resolved: wanted.length };
  });
}
