import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DatabaseExecutor } from "../platform/db";
import { leadMagnets, leadMagnetVersions } from "../lead-magnets/schema";
import { InvalidKnowledgeError, KNOWLEDGE_MAX_CHARS, formatChars, readKnowledgeFile } from "./knowledge-file";
import { knowledgeBases } from "./schema";

export type KnowledgeBase = Pick<typeof knowledgeBases.$inferSelect, "id" | "title" | "fileName" | "charCount" | "byteSize" | "updatedAt">;
export type KnowledgeBaseWithText = KnowledgeBase & { content: string };

/** Лидмагнит, к которому прикреплена база: в черновике или в опубликованной версии. */
export interface KnowledgeUser {
  id: string;
  name: string;
}

export type KnowledgeBaseListItem = KnowledgeBase & { usedBy: KnowledgeUser[] };

export interface KnowledgeFile {
  name: string;
  bytes: Uint8Array;
}

const NOT_FOUND = "База знаний не найдена — обновите страницу";

const baseColumns = {
  id: knowledgeBases.id,
  title: knowledgeBases.title,
  fileName: knowledgeBases.fileName,
  charCount: knowledgeBases.charCount,
  byteSize: knowledgeBases.byteSize,
  updatedAt: knowledgeBases.updatedAt,
};

/** Имя файла без пути и расширения — название по умолчанию. */
const titleFromFileName = (name: string) => name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").trim();

function fileFields(file: KnowledgeFile) {
  const { content, charCount } = readKnowledgeFile(file);
  return { fileName: file.name.replace(/^.*[\\/]/, ""), content, charCount, byteSize: file.bytes.byteLength };
}

/**
 * Лидмагниты (черновик или опубликованная версия) и id баз, прикреплённых в них. `sets` — базы черновика и опубликованной
 * версии порознь: консультант получает базы одной версии, и предел действует на каждую отдельно.
 */
async function attachments(db: DatabaseExecutor): Promise<Array<KnowledgeUser & { knowledgeIds: string[]; sets: string[][] }>> {
  const published = alias(leadMagnetVersions, "published");
  const rows = await db
    .select({ id: leadMagnets.id, draft: leadMagnets.draft, published: published.settings })
    .from(leadMagnets)
    .leftJoin(published, eq(published.id, leadMagnets.publishedSnapshotId));
  return rows.map((row) => {
    const sets = [row.draft.knowledgeIds ?? [], ...(row.published ? [row.published.knowledgeIds ?? []] : [])];
    return { id: row.id, name: row.draft.name, knowledgeIds: [...new Set(sets.flat())], sets };
  });
}

/** Базы без удалённых, новые сверху, с лидмагнитами, к которым они прикреплены. */
export async function listKnowledgeBases(db: DatabaseExecutor): Promise<KnowledgeBaseListItem[]> {
  const [bases, leads] = await Promise.all([
    db.select(baseColumns).from(knowledgeBases).where(isNull(knowledgeBases.deletedAt)).orderBy(desc(knowledgeBases.createdAt)),
    attachments(db),
  ]);
  return bases.map((base) => ({
    ...base,
    usedBy: leads.filter((lead) => lead.knowledgeIds.includes(base.id)).map(({ id, name }) => ({ id, name })),
  }));
}

/** Неудалённые базы с текстом; порядок — как в `ids`, неизвестные пропускаются. */
export async function getKnowledgeBases(db: DatabaseExecutor, ids: readonly string[]): Promise<KnowledgeBaseWithText[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ ...baseColumns, content: knowledgeBases.content })
    .from(knowledgeBases)
    .where(and(inArray(knowledgeBases.id, [...ids]), isNull(knowledgeBases.deletedAt)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Сколько знаков занимают живые базы с этими id. */
export async function knowledgeChars(db: DatabaseExecutor, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .select({ charCount: knowledgeBases.charCount })
    .from(knowledgeBases)
    .where(and(inArray(knowledgeBases.id, [...new Set(ids)]), isNull(knowledgeBases.deletedAt)));
  return rows.reduce((sum, row) => sum + row.charCount, 0);
}

/** Текст сверх предела лидмагнита — ошибка для эксперта. */
export function knowledgeOverLimit(total: number): string | null {
  return total > KNOWLEDGE_MAX_CHARS
    ? `Базы знаний занимают ${formatChars(total)} знаков, а консультанту помещается до ${formatChars(KNOWLEDGE_MAX_CHARS)} — открепите лишнее`
    : null;
}

export async function createKnowledgeBase(db: DatabaseExecutor, input: { title: string }, file: KnowledgeFile): Promise<KnowledgeBase> {
  const fields = fileFields(file);
  const title = input.title.trim() || titleFromFileName(file.name) || "Без названия";
  const [created] = await db.insert(knowledgeBases).values({ title, ...fields }).returning(baseColumns);
  return created!;
}

export async function renameKnowledgeBase(db: DatabaseExecutor, id: string, title: string): Promise<KnowledgeBase> {
  const trimmed = title.trim();
  if (!trimmed) throw new InvalidKnowledgeError("Напишите название базы знаний");
  // Без изменений базу не трогаем: новый updatedAt сменил бы ключ службы и сбросил кэш модели у всех разговоров
  const [current] = await db
    .select(baseColumns)
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, id), isNull(knowledgeBases.deletedAt)));
  if (current?.title === trimmed) return current;
  const [updated] = await db
    .update(knowledgeBases)
    .set({ title: trimmed, updatedAt: new Date() })
    .where(and(eq(knowledgeBases.id, id), isNull(knowledgeBases.deletedAt)))
    .returning(baseColumns);
  if (!updated) throw new InvalidKnowledgeError(NOT_FOUND);
  return updated;
}

/**
 * Новый файл вместо прежнего: консультанты всех лидмагнитов с этой базой со следующего хода получают новый текст.
 * Не помещается в предел хоть одного из них — ошибка с его названием.
 */
export async function replaceKnowledgeFile(db: DatabaseExecutor, id: string, file: KnowledgeFile): Promise<KnowledgeBase> {
  const fields = fileFields(file);
  const [existing] = await db.select(baseColumns).from(knowledgeBases).where(and(eq(knowledgeBases.id, id), isNull(knowledgeBases.deletedAt)));
  if (!existing) throw new InvalidKnowledgeError(NOT_FOUND);
  for (const lead of (await attachments(db)).filter((one) => one.knowledgeIds.includes(id))) {
    const withBase = lead.sets.filter((set) => set.includes(id));
    const others = Math.max(...(await Promise.all(withBase.map((set) => knowledgeChars(db, set.filter((other) => other !== id))))));
    if (others + fields.charCount > KNOWLEDGE_MAX_CHARS) {
      throw new InvalidKnowledgeError(
        `С новым файлом базы лидмагнита «${lead.name}» займут ${formatChars(others + fields.charCount)} знаков, а помещается до ${formatChars(KNOWLEDGE_MAX_CHARS)} — сократите файл или открепите базы в лидмагните`,
      );
    }
  }
  const [updated] = await db
    .update(knowledgeBases)
    .set({ ...fields, updatedAt: new Date() })
    .where(and(eq(knowledgeBases.id, id), isNull(knowledgeBases.deletedAt)))
    .returning(baseColumns);
  if (!updated) throw new InvalidKnowledgeError(NOT_FOUND);
  return updated;
}

/** Правка в окне базы: новый файл (если выбран) и название сохраняются вместе или не сохраняется ничего. */
export async function editKnowledgeBase(db: DatabaseExecutor, id: string, edit: { title: string; file?: KnowledgeFile }): Promise<KnowledgeBase> {
  return db.transaction(async (tx) => {
    if (edit.file) await replaceKnowledgeFile(tx, id, edit.file);
    return renameKnowledgeBase(tx, id, edit.title);
  });
}

/** База пропадает из архива и из инструкций консультантов. Повторное удаление ничего не меняет. */
export async function deleteKnowledgeBase(db: DatabaseExecutor, id: string, at: Date): Promise<void> {
  await db
    .update(knowledgeBases)
    .set({ deletedAt: at })
    .where(and(eq(knowledgeBases.id, id), isNull(knowledgeBases.deletedAt)));
}
