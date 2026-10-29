import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../platform/db";
import { isUuid } from "../platform/uuid";
import { FIELD_TYPES, fields, people, type FieldType, type PersonFact, type PersonFieldValue } from "./schema";

export type FieldDefinition = Pick<typeof fields.$inferSelect, "id" | "name" | "type" | "options" | "description">;

export interface NewField {
  name: string;
  type: FieldType;
  options?: string[];
  description: string;
}

export class InvalidFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFieldError";
  }
}

const definitionColumns = {
  id: fields.id,
  name: fields.name,
  type: fields.type,
  options: fields.options,
  description: fields.description,
};

/** Словарь полей без удалённых, по имени. */
export async function listFields(db: DatabaseExecutor): Promise<FieldDefinition[]> {
  return db.select(definitionColumns).from(fields).where(isNull(fields.deletedAt)).orderBy(asc(fields.name));
}

/** Неудалённые поля с этими id; порядок — как в `ids`, неизвестные пропускаются. */
export async function getFields(db: DatabaseExecutor, ids: readonly string[]): Promise<FieldDefinition[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(definitionColumns)
    .from(fields)
    .where(and(inArray(fields.id, [...ids]), isNull(fields.deletedAt)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Какие из этих id — поля, удалённые из словаря. Id, которого в словаре не было, сюда не попадает. */
export async function deletedFieldIds(db: DatabaseExecutor, ids: readonly string[]): Promise<string[]> {
  const candidates = [...new Set(ids.filter(isUuid))];
  if (candidates.length === 0) return [];
  const rows = await db
    .select({ id: fields.id })
    .from(fields)
    .where(and(inArray(fields.id, candidates), isNotNull(fields.deletedAt)));
  return rows.map((row) => row.id);
}

export async function createField(db: DatabaseExecutor, input: NewField): Promise<FieldDefinition> {
  const name = input.name.trim();
  if (!name) throw new InvalidFieldError("У поля должно быть имя");
  if (!FIELD_TYPES.includes(input.type)) throw new InvalidFieldError(`Неизвестный тип поля: ${input.type}`);
  const options = (input.options ?? []).map((option) => option.trim()).filter(Boolean);
  if (input.type === "choice" && options.length < 2) throw new InvalidFieldError("У поля с выбором нужно хотя бы два варианта");
  if (input.type !== "choice" && options.length > 0) throw new InvalidFieldError("Варианты бывают только у поля с выбором");

  await ensureNameFree(db, name);

  const [created] = await db
    .insert(fields)
    .values({ name, type: input.type, options, description: input.description.trim() })
    .returning(definitionColumns);
  return created!;
}

/** Подходит ли значение под тип поля. */
export function isValidFieldValue(field: FieldDefinition, value: unknown): boolean {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "text":
      return typeof value === "string";
    case "choice":
      return typeof value === "string" && field.options.includes(value);
  }
}

async function ensureNameFree(db: DatabaseExecutor, name: string, exceptId?: string): Promise<void> {
  const [taken] = await db
    .select({ id: fields.id })
    .from(fields)
    .where(and(sql`lower(${fields.name}) = lower(${name})`, isNull(fields.deletedAt), exceptId ? ne(fields.id, exceptId) : undefined));
  if (taken) throw new InvalidFieldError(`Поле «${name}» уже есть в словаре`);
}

async function lockLiveField(tx: DatabaseExecutor, id: string) {
  const [field] = await tx.select().from(fields).where(eq(fields.id, id)).for("update");
  if (!field) throw new InvalidFieldError("Такого поля нет в словаре");
  return field;
}

/** Новое имя поля. Значения у людей остаются: они хранятся по id поля. */
export async function renameField(db: DatabaseExecutor, id: string, newName: string): Promise<FieldDefinition> {
  const name = newName.trim();
  if (!name) throw new InvalidFieldError("У поля должно быть имя");
  return db.transaction(async (tx) => {
    const field = await lockLiveField(tx, id);
    if (field.deletedAt) throw new InvalidFieldError("Поле уже удалено");
    await ensureNameFree(tx, name, id);
    const [renamed] = await tx.update(fields).set({ name }).where(eq(fields.id, id)).returning(definitionColumns);
    return renamed!;
  });
}

/** Значение поля так, как его прочтёт человек: «да» вместо true. */
export function fieldValueText(value: PersonFieldValue): string {
  if (typeof value === "boolean") return value ? "да" : "нет";
  return String(value);
}

/**
 * Удаляет поле из словаря. Значения не пропадают: у каждого человека они переходят в свободные факты
 * «<поле>: <значение>», а из значений полей убираются. Поле помечается удалённым. Повторное удаление ничего не меняет.
 */
export async function deleteField(db: DatabaseExecutor, id: string, at: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const field = await lockLiveField(tx, id);
    if (field.deletedAt) return;
    const holders = await tx
      .select({ id: people.id, value: sql<PersonFieldValue>`${people.fieldValues} -> ${id}` })
      .from(people)
      .where(sql`${people.fieldValues} ? ${id}`)
      .for("update");
    for (const holder of holders) {
      const fact: PersonFact = { text: `${field.name}: ${fieldValueText(holder.value)}`, at: at.toISOString(), source: `field:${id}` };
      await tx
        .update(people)
        .set({
          facts: sql`${people.facts} || ${JSON.stringify([fact])}::jsonb`,
          fieldValues: sql`${people.fieldValues} - ${id}`,
        })
        .where(eq(people.id, holder.id));
    }
    await tx.update(fields).set({ deletedAt: at }).where(eq(fields.id, id));
  });
}
