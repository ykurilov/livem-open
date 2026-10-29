import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { bots } from "../channels/schema";
import { PASSAGE_STATUSES, passages, type PassageStatus } from "../conversations/schema";
import { entryLinks, leadMagnets } from "../lead-magnets/schema";
import type { DatabaseExecutor } from "../platform/db";
import { people } from "./schema";

const ids = z.array(z.uuid()).optional();

const fieldConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ fieldId: z.uuid(), kind: z.literal("boolean"), equals: z.boolean() }),
  z.strictObject({ fieldId: z.uuid(), kind: z.literal("choice"), anyOf: z.array(z.string()).min(1) }),
  z
    .strictObject({ fieldId: z.uuid(), kind: z.literal("number"), min: z.number().optional(), max: z.number().optional() })
    .refine((condition) => condition.min === undefined || condition.max === undefined || condition.min <= condition.max, {
      message: "«от» больше «до»",
    }),
  z.strictObject({ fieldId: z.uuid(), kind: z.literal("text"), contains: z.string().trim().min(1) }),
]);

const peopleFilterSchema = z.strictObject({
  botIds: ids,
  leadMagnetIds: ids,
  linkIds: ids,
  statuses: z.array(z.enum(PASSAGE_STATUSES)).optional(),
  fieldConditions: z.array(fieldConditionSchema).optional(),
  withoutActivePassage: z.boolean().optional(),
});

/** Условие по полю словаря. Вид условия задаёт тип поля: да/нет, выбор из списка, число, текст. */
export type FieldCondition = z.infer<typeof fieldConditionSchema>;

/**
 * Фильтр базы — общий для экрана «База» и рассылок (там он хранится в `mailings.filter`).
 * Пустой или не заданный список — без ограничения. Лидмагнит, метка и статус относятся к одному прохождению.
 */
export type PeopleFilter = z.infer<typeof peopleFilterSchema>;

export class InvalidPeopleFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPeopleFilterError";
  }
}

/** Проверяет фильтр из формы или из базы. Пустые списки отбрасываются. */
export function parsePeopleFilter(input: unknown): PeopleFilter {
  const parsed = peopleFilterSchema.safeParse(input);
  if (!parsed.success) throw new InvalidPeopleFilterError(`Фильтр не подходит: ${z.prettifyError(parsed.error)}`);
  return Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => !(Array.isArray(value) && value.length === 0) && value !== undefined),
  ) as PeopleFilter;
}

const filled = <T>(list: readonly T[] | undefined): list is readonly T[] => Boolean(list && list.length > 0);

function fieldConditionSql(condition: FieldCondition): SQL {
  const value = sql`${people.fieldValues} -> ${condition.fieldId}`;
  switch (condition.kind) {
    case "boolean":
      return sql`${value} = ${JSON.stringify(condition.equals)}::jsonb`;
    case "choice":
      return sql`${value} in (${sql.join(
        condition.anyOf.map((option) => sql`${JSON.stringify(option)}::jsonb`),
        sql`, `,
      )})`;
    case "number": {
      // Только настоящие числа: строка «40» под «больше 20» не попадает
      // CASE: Postgres не обещает проверить тип раньше приведения
      const number = sql`(case when jsonb_typeof(${value}) = 'number' then (${people.fieldValues} ->> ${condition.fieldId})::numeric end)`;
      return sql.join(
        [
          sql`jsonb_typeof(${value}) = 'number'`,
          ...(condition.min !== undefined ? [sql`${number} >= ${condition.min}`] : []),
          ...(condition.max !== undefined ? [sql`${number} <= ${condition.max}`] : []),
        ],
        sql` and `,
      );
    }
    case "text": {
      const pattern = `%${condition.contains.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      return sql`jsonb_typeof(${value}) = 'string' and (${people.fieldValues} ->> ${condition.fieldId}) ilike ${pattern}`;
    }
  }
}

/** Условие отбора людей по фильтру — для любого запроса к `people`. `undefined` — без ограничений. */
export function peopleFilterCondition(filter: PeopleFilter): SQL | undefined {
  const parts: SQL[] = [];
  if (filled(filter.botIds)) parts.push(inArray(people.botId, [...filter.botIds]));

  const passageParts: SQL[] = [];
  if (filled(filter.leadMagnetIds)) passageParts.push(inArray(passages.leadMagnetId, [...filter.leadMagnetIds]));
  if (filled(filter.linkIds)) passageParts.push(inArray(passages.entryLinkId, [...filter.linkIds]));
  if (filled(filter.statuses)) passageParts.push(inArray(passages.status, [...filter.statuses]));
  if (passageParts.length > 0)
    parts.push(sql`exists (select 1 from ${passages} where ${and(eq(passages.personId, people.id), ...passageParts)})`);

  if (filter.withoutActivePassage)
    parts.push(sql`not exists (select 1 from ${passages} where ${and(eq(passages.personId, people.id), eq(passages.status, "active"))})`);

  for (const condition of filter.fieldConditions ?? []) parts.push(fieldConditionSql(condition));
  return parts.length > 0 ? and(...parts) : undefined;
}

export async function countPeople(db: DatabaseExecutor, filter: PeopleFilter): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(people).where(peopleFilterCondition(filter));
  return row?.count ?? 0;
}

export interface PersonListItem {
  id: string;
  displayName: string | null;
  channel: typeof people.$inferSelect.channel;
  botTitle: string;
  blockedAt: Date | null;
  createdAt: Date;
  /** Откуда человек, если пришёл не через лидмагнит. */
  source: typeof people.$inferSelect.source;
  /** Последнее начатое прохождение. */
  lastPassage: { leadMagnetName: string; status: PassageStatus } | null;
}

/** Люди по фильтру, новые сверху. */
export async function listPeople(
  db: DatabaseExecutor,
  filter: PeopleFilter,
  page: { limit: number; offset: number } = { limit: 50, offset: 0 },
): Promise<PersonListItem[]> {
  const lastPassage = db
    .select({
      leadMagnetName: sql<string>`${leadMagnets.draft} ->> 'name'`.as("lead_magnet_name"),
      status: passages.status,
    })
    .from(passages)
    .innerJoin(leadMagnets, eq(leadMagnets.id, passages.leadMagnetId))
    .where(eq(passages.personId, people.id))
    .orderBy(desc(passages.startedAt))
    .limit(1)
    .as("last_passage");

  const rows = await db
    .select({
      id: people.id,
      displayName: people.displayName,
      channel: people.channel,
      botTitle: bots.title,
      blockedAt: people.blockedAt,
      createdAt: people.createdAt,
      source: people.source,
      leadMagnetName: lastPassage.leadMagnetName,
      status: lastPassage.status,
    })
    .from(people)
    .innerJoin(bots, eq(bots.id, people.botId))
    .leftJoinLateral(lastPassage, sql`true`)
    .where(peopleFilterCondition(filter))
    .orderBy(desc(people.createdAt), desc(people.id))
    .limit(page.limit)
    .offset(page.offset);

  return rows.map(({ leadMagnetName, status, ...row }) => ({
    ...row,
    lastPassage: status ? { leadMagnetName: leadMagnetName ?? "", status } : null,
  }));
}

export interface PeopleFilterOptions {
  bots: Array<{ id: string; title: string; channel: typeof people.$inferSelect.channel }>;
  leadMagnets: Array<{ id: string; name: string }>;
  /** Ссылки с меткой (основные ссылки без метки не нужны: их отличает лидмагнит). */
  links: Array<{ id: string; label: string; leadMagnetName: string }>;
}

/** Из чего выбирать в фильтре: боты, лидмагниты, метки ссылок. Поля — из словаря (`listFields`). */
export async function listPeopleFilterOptions(db: DatabaseExecutor): Promise<PeopleFilterOptions> {
  const [botRows, leadRows, linkRows] = await Promise.all([
    db.select({ id: bots.id, title: bots.title, channel: bots.channel }).from(bots).orderBy(bots.title),
    db.select({ id: leadMagnets.id, name: sql<string>`${leadMagnets.draft} ->> 'name'` }).from(leadMagnets).orderBy(desc(leadMagnets.createdAt)),
    db
      .select({ id: entryLinks.id, label: entryLinks.label, leadMagnetName: sql<string>`${leadMagnets.draft} ->> 'name'` })
      .from(entryLinks)
      .innerJoin(leadMagnets, eq(leadMagnets.id, entryLinks.leadMagnetId))
      .where(isNotNull(entryLinks.label))
      .orderBy(entryLinks.label),
  ]);
  return { bots: botRows, leadMagnets: leadRows, links: linkRows.map((link) => ({ ...link, label: link.label! })) };
}
