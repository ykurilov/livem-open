import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../platform/db";
import { systemClock, type Clock } from "../platform/clock";
import { leadMagnets, leadMagnetVersions, type ManualEditNote, type VersionSource } from "./schema";
import { averagePassageCosts } from "./stats";
import { newLeadMagnetSettings, validateLeadMagnetSettings, type LeadMagnetSettings } from "./settings";

export type LeadMagnet = Omit<typeof leadMagnets.$inferSelect, "draftVersionId"> & { draftVersionId: string };
export type LeadMagnetVersion = typeof leadMagnetVersions.$inferSelect;

export interface LeadMagnetCard {
  id: string;
  name: string;
  cardDescription: string;
  published: boolean;
  updatedAt: Date;
  /** Средняя цена завершённого прохождения, $; `null` — завершённых ещё нет. */
  averagePassageCostUsd: number | null;
}

function asLeadMagnet(row: typeof leadMagnets.$inferSelect): LeadMagnet {
  if (!row.draftVersionId) throw new Error(`У лидмагнита ${row.id} нет версии черновика`);
  return { ...row, draftVersionId: row.draftVersionId };
}

/** Новый лидмагнит: черновик с настройками по умолчанию и его первая версия. */
export async function createLeadMagnet(
  db: DatabaseExecutor,
  input: { name: string; cardDescription?: string },
): Promise<LeadMagnet> {
  const settings = validateLeadMagnetSettings(newLeadMagnetSettings(input.name, input.cardDescription));
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(leadMagnets).values({ draft: settings }).returning();
    const [version] = await tx
      .insert(leadMagnetVersions)
      .values({ leadMagnetId: created!.id, settings, source: "manual" })
      .returning();
    const [updated] = await tx
      .update(leadMagnets)
      .set({ draftVersionId: version!.id })
      .where(eq(leadMagnets.id, created!.id))
      .returning();
    return asLeadMagnet(updated!);
  });
}

export async function getLeadMagnet(db: DatabaseExecutor, id: string): Promise<LeadMagnet | null> {
  const [row] = await db.select().from(leadMagnets).where(eq(leadMagnets.id, id));
  return row ? asLeadMagnet(row) : null;
}

export class LeadMagnetNotFoundError extends Error {
  constructor(id: string) {
    super(`Лидмагнит ${id} не найден: возможно, его удалили`);
    this.name = "LeadMagnetNotFoundError";
  }
}

async function requireLeadMagnet(db: DatabaseExecutor, id: string): Promise<LeadMagnet> {
  const found = await getLeadMagnet(db, id);
  if (!found) throw new LeadMagnetNotFoundError(id);
  return found;
}

/**
 * Читает лидмагнит и блокирует его строку до конца транзакции: правки конструктора, эксперта и откаты
 * идут по очереди, каждая видит результат предыдущей.
 */
export async function lockLeadMagnet(tx: DatabaseExecutor, id: string): Promise<LeadMagnet> {
  const [row] = await tx.select().from(leadMagnets).where(eq(leadMagnets.id, id)).for("update");
  if (!row) throw new LeadMagnetNotFoundError(id);
  return asLeadMagnet(row);
}

/** Сохраняет черновик: новая неизменная версия и ссылка на неё. Настройки проверяются целиком. */
export async function saveDraft(
  db: DatabaseExecutor,
  leadMagnetId: string,
  settings: LeadMagnetSettings,
  source: VersionSource,
): Promise<LeadMagnetVersion> {
  const valid = validateLeadMagnetSettings(settings);
  return db.transaction(async (tx) => {
    const [version] = await tx
      .insert(leadMagnetVersions)
      .values({ leadMagnetId, settings: valid, source })
      .returning();
    const updated = await tx
      .update(leadMagnets)
      .set({ draft: valid, draftVersionId: version!.id, updatedAt: sql`now()` })
      .where(eq(leadMagnets.id, leadMagnetId))
      .returning({ id: leadMagnets.id });
    if (updated.length === 0) throw new LeadMagnetNotFoundError(leadMagnetId);
    return version!;
  });
}

/** Откат: настройки выбранной версии становятся черновиком через новую версию «rollback». */
export async function rollbackToVersion(
  db: DatabaseExecutor,
  leadMagnetId: string,
  versionId: string,
): Promise<LeadMagnetVersion> {
  const [version] = await db
    .select()
    .from(leadMagnetVersions)
    .where(and(eq(leadMagnetVersions.id, versionId), eq(leadMagnetVersions.leadMagnetId, leadMagnetId)));
  if (!version) throw new Error(`У лидмагнита ${leadMagnetId} нет версии ${versionId}`);
  return saveDraft(db, leadMagnetId, version.settings, "rollback");
}

/** Версии лидмагнита, новые первыми. */
export async function listVersions(db: DatabaseExecutor, leadMagnetId: string): Promise<LeadMagnetVersion[]> {
  return db
    .select()
    .from(leadMagnetVersions)
    .where(eq(leadMagnetVersions.leadMagnetId, leadMagnetId))
    .orderBy(desc(leadMagnetVersions.createdAt));
}

export async function getVersion(db: DatabaseExecutor, versionId: string): Promise<LeadMagnetVersion | null> {
  const [version] = await db.select().from(leadMagnetVersions).where(eq(leadMagnetVersions.id, versionId));
  return version ?? null;
}

export async function listLeadMagnetCards(db: DatabaseExecutor): Promise<LeadMagnetCard[]> {
  const [rows, averageCosts] = await Promise.all([
    db.select().from(leadMagnets).orderBy(desc(leadMagnets.updatedAt)),
    averagePassageCosts(db),
  ]);
  return rows.map((row) => ({
    id: row.id,
    name: row.draft.name,
    cardDescription: row.draft.cardDescription,
    published: row.publishedSnapshotId !== null,
    updatedAt: row.updatedAt,
    averagePassageCostUsd: averageCosts.get(row.id) ?? null,
  }));
}

export async function findLeadMagnetByConstructorChat(db: DatabaseExecutor, chatId: string): Promise<LeadMagnet | null> {
  const [row] = await db.select().from(leadMagnets).where(eq(leadMagnets.constructorChatId, chatId));
  return row ? asLeadMagnet(row) : null;
}

export async function findLeadMagnetByPreviewChat(db: DatabaseExecutor, chatId: string): Promise<LeadMagnet | null> {
  const [row] = await db.select().from(leadMagnets).where(eq(leadMagnets.previewChatId, chatId));
  return row ? asLeadMagnet(row) : null;
}

/** Привязывает чат конструктора, если его ещё нет. Возвращает чат, который в итоге привязан. */
export async function attachConstructorChat(db: DatabaseExecutor, leadMagnetId: string, chatId: string): Promise<string> {
  await db
    .update(leadMagnets)
    .set({ constructorChatId: chatId })
    .where(and(eq(leadMagnets.id, leadMagnetId), sql`${leadMagnets.constructorChatId} is null`));
  const lead = await requireLeadMagnet(db, leadMagnetId);
  return lead.constructorChatId!;
}

/** Текущий тестовый разговор; «Начать заново» ставит новый. */
export async function setPreviewChat(db: DatabaseExecutor, leadMagnetId: string, chatId: string): Promise<void> {
  await db.update(leadMagnets).set({ previewChatId: chatId }).where(eq(leadMagnets.id, leadMagnetId));
}

export async function appendManualEditNotes(
  db: DatabaseExecutor,
  leadMagnetId: string,
  texts: string[],
  clock: Clock = systemClock,
): Promise<void> {
  if (texts.length === 0) return;
  const at = clock.now().toISOString();
  const notes: ManualEditNote[] = texts.map((text) => ({ id: randomUUID(), text, at }));
  await db
    .update(leadMagnets)
    .set({ pendingManualEdits: sql`${leadMagnets.pendingManualEdits} || ${JSON.stringify(notes)}::jsonb` })
    .where(eq(leadMagnets.id, leadMagnetId));
}

/** Стирает только переданные заметки: пришедшие за время хода остаются до следующего. */
export async function clearManualEditNotes(db: DatabaseExecutor, leadMagnetId: string, noteIds: string[]): Promise<void> {
  if (noteIds.length === 0) return;
  const consumed = new Set(noteIds);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ notes: leadMagnets.pendingManualEdits })
      .from(leadMagnets)
      .where(eq(leadMagnets.id, leadMagnetId))
      .for("update");
    if (!row) return;
    const remaining = row.notes.filter((note) => !consumed.has(note.id));
    await tx.update(leadMagnets).set({ pendingManualEdits: remaining }).where(eq(leadMagnets.id, leadMagnetId));
  });
}
