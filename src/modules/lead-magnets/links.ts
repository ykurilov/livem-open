import { randomInt } from "node:crypto";
import { and, asc, eq, exists, isNotNull, isNull, sql } from "drizzle-orm";
import type { ChannelAdapters, ChannelKind } from "../channels/channel";
import { passages } from "../conversations/schema";
import { isUniqueViolation, type DatabaseExecutor } from "../platform/db";
import { isUuid } from "../platform/uuid";
import { LeadMagnetNotFoundError } from "./lead-magnets";
import { listAttachedBots } from "./publish";
import { entryLinks, leadMagnets } from "./schema";
import { ENTRY_LABEL_SEPARATOR } from "./start-payload";

export type EntryLink = typeof entryLinks.$inferSelect;

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CODE_LENGTH = 8;
const CODE_ATTEMPTS = 5;

/** Новый код ссылки: 8 знаков `A-Za-z0-9` (62⁸ вариантов, подобрать чужой — безнадёжно). */
export function generateEntryCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Основная ссылка лидмагнита (без метки). Нет — создаёт; совпадение кода с чужим — пробует другой. */
export async function ensureMainEntryLink(db: DatabaseExecutor, leadMagnetId: string): Promise<EntryLink> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const existing = await findMainEntryLink(db, leadMagnetId);
    if (existing) return existing;
    const [created] = await db
      .insert(entryLinks)
      .values({ leadMagnetId, code: generateEntryCode() })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
  }
  throw new Error("Не удалось подобрать свободный код ссылки");
}

async function findMainEntryLink(db: DatabaseExecutor, leadMagnetId: string): Promise<EntryLink | null> {
  const [link] = await db
    .select()
    .from(entryLinks)
    .where(and(eq(entryLinks.leadMagnetId, leadMagnetId), isNull(entryLinks.label)));
  return link ?? null;
}

/** Ссылка по коду из `/start`. Архивные тоже находятся: человек по старой ссылке всё равно попадёт в лидмагнит. */
export async function findEntryLinkByCode(db: DatabaseExecutor, code: string): Promise<EntryLink | null> {
  const [link] = await db.select().from(entryLinks).where(eq(entryLinks.code, code));
  return link ?? null;
}

/**
 * Метка из стартового параметра: существующую действующую ручную метку объединяем без учёта регистра.
 * Автоматический код каноничен: архивная автоматическая ссылка остаётся той же ссылкой (как ручная).
 * ON CONFLICT без исключения не прерывает внешнюю транзакцию при одновременных первых входах.
 * Вызывается только после решения действительно начать прохождение.
 */
export async function ensurePayloadEntryLink(db: DatabaseExecutor, main: EntryLink, label: string): Promise<EntryLink> {
  const code = `${main.code}${ENTRY_LABEL_SEPARATOR}${label}`;
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const exact = await findEntryLinkByCode(db, code);
    if (exact) return exact;
    const [existing] = await db.select().from(entryLinks).where(and(
      eq(entryLinks.leadMagnetId, main.leadMagnetId),
      isNull(entryLinks.archivedAt),
      sql`lower(${entryLinks.label}) = lower(${label})`,
    ));
    if (existing) return existing;
    const [created] = await db.insert(entryLinks).values({ leadMagnetId: main.leadMagnetId, code, label })
      .onConflictDoNothing().returning();
    if (created) return created;
    // Соседняя транзакция создала метку: следующий SELECT увидит её после ожидания уникального индекса.
  }
  throw new Error("Не удалось записать рекламную метку");
}

/** Ошибка действия со ссылкой; текст показывается эксперту. */
export class EntryLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntryLinkError";
  }
}

const LABEL_MAX_LENGTH = 100;
const LINK_NOT_FOUND = "Ссылка не найдена: возможно, её уже удалили";

/** Рекламная ссылка с меткой и адресами в привязанных мессенджерах. */
export interface LabeledLink {
  id: string;
  label: string;
  code: string;
  createdAt: Date;
  /** По ссылке уже приходили люди: удалить нельзя, только в архив. */
  hasPeople: boolean;
  urls: Array<{ channel: ChannelKind; url: string }>;
}

/**
 * «Новая ссылка»: метка и свой случайный код. Действующая метка с тем же именем (без учёта регистра) — ошибка;
 * одновременные запросы с одной меткой разводит уникальный индекс базы.
 */
export async function createLabeledLink(
  db: DatabaseExecutor,
  input: { leadMagnetId: string; label: string },
): Promise<EntryLink> {
  const label = input.label.trim();
  if (!label) throw new EntryLinkError("Впишите метку, например «Блогер Маша»");
  if (label.length > LABEL_MAX_LENGTH) throw new EntryLinkError(`Метка — не длиннее ${LABEL_MAX_LENGTH} знаков`);
  if (!isUuid(input.leadMagnetId)) throw new LeadMagnetNotFoundError(input.leadMagnetId);
  const [lead] = await db.select({ id: leadMagnets.id }).from(leadMagnets).where(eq(leadMagnets.id, input.leadMagnetId));
  if (!lead) throw new LeadMagnetNotFoundError(input.leadMagnetId);
  const duplicate = new EntryLinkError(`Метка «${label}» уже есть`);
  const [same] = await db
    .select({ id: entryLinks.id })
    .from(entryLinks)
    .where(
      and(
        eq(entryLinks.leadMagnetId, input.leadMagnetId),
        isNull(entryLinks.archivedAt),
        sql`lower(${entryLinks.label}) = lower(${label})`,
      ),
    );
  if (same) throw duplicate;

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    try {
      const [created] = await db
        .insert(entryLinks)
        .values({ leadMagnetId: input.leadMagnetId, code: generateEntryCode(), label })
        .onConflictDoNothing({ target: entryLinks.code })
        .returning();
      if (created) return created;
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate;
      throw error;
    }
  }
  throw new Error("Не удалось подобрать свободный код ссылки");
}

/** Действующие (не архивные) ссылки с меткой, по порядку создания, с адресом в каждом привязанном мессенджере. */
export async function listLabeledLinks(
  db: DatabaseExecutor,
  adapters: ChannelAdapters,
  leadMagnetId: string,
): Promise<LabeledLink[]> {
  const rows = await db
    .select({
      id: entryLinks.id,
      label: entryLinks.label,
      code: entryLinks.code,
      createdAt: entryLinks.createdAt,
      hasPeople: exists(db.select({ one: sql`1` }).from(passages).where(eq(passages.entryLinkId, entryLinks.id))),
    })
    .from(entryLinks)
    .where(and(eq(entryLinks.leadMagnetId, leadMagnetId), isNotNull(entryLinks.label), isNull(entryLinks.archivedAt)))
    .orderBy(asc(entryLinks.createdAt), asc(entryLinks.id));
  const attached = await listAttachedBots(db, leadMagnetId);
  return rows.map((row) => ({
    ...row,
    label: row.label!,
    hasPeople: Boolean(row.hasPeople),
    urls: attached.flatMap((bot) => {
      const adapter = adapters[bot.channel];
      return adapter ? [{ channel: bot.channel, url: adapter.entryLink(bot, row.code) }] : [];
    }),
  }));
}

/** Удаляет ссылку с меткой. Основную нельзя; по ссылке приходили люди — только архив. */
export async function deleteEntryLink(db: DatabaseExecutor, linkId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const link = await labeledLinkForChange(tx, linkId);
    const [used] = await tx.select({ id: passages.id }).from(passages).where(eq(passages.entryLinkId, link.id)).limit(1);
    if (used) throw new EntryLinkError(`По метке «${link.label}» уже приходили люди: её можно только отправить в архив`);
    await tx.delete(entryLinks).where(eq(entryLinks.id, link.id));
  });
}

/** Прячет ссылку с меткой. Ссылка продолжает вести в лидмагнит, а метка — считаться в отчёте. */
export async function archiveEntryLink(db: DatabaseExecutor, linkId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const link = await labeledLinkForChange(tx, linkId);
    if (!link.archivedAt) await tx.update(entryLinks).set({ archivedAt: new Date() }).where(eq(entryLinks.id, link.id));
  });
}

async function labeledLinkForChange(tx: DatabaseExecutor, linkId: string): Promise<EntryLink> {
  if (!isUuid(linkId)) throw new EntryLinkError(LINK_NOT_FOUND);
  const [link] = await tx.select().from(entryLinks).where(eq(entryLinks.id, linkId)).for("update");
  if (!link) throw new EntryLinkError(LINK_NOT_FOUND);
  if (link.label === null) throw new EntryLinkError("Основную ссылку лидмагнита нельзя удалить или отправить в архив");
  return link;
}
