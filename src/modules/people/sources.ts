import { and, eq, isNotNull, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { passages } from "../conversations/schema";
import { entryLinks, leadMagnets } from "../lead-magnets/schema";
import type { DatabaseExecutor } from "../platform/db";

/** Вид источника: метка, основная ссылка лидмагнита или начало без ссылки (лидмагнит по умолчанию, меню бота). */
export type SourceKind = "label" | "main" | "none";

export interface SourceRow {
  /** Ссылка первого прихода; `null` — пришли без ссылки. */
  linkId: string | null;
  kind: SourceKind;
  /** Метка; `null` у основной ссылки и у строки «без ссылки». */
  label: string | null;
  archived: boolean;
  leadMagnetId: string;
  leadMagnetName: string;
  /** Людей, впервые начавших лидмагнит по этому источнику в периоде. */
  arrived: number;
  /** Из них — дошли до конца хотя бы одного разговора этого лидмагнита. */
  completed: number;
  /** Из них — купили к сегодняшнему дню (покупка не отменена возвратом). */
  purchased: number;
  /** Расход ИИ на все разговоры этих людей в лидмагните, $. */
  costUsd: number;
}

export interface SourcesReport {
  /** Лучшие сверху: по «пришли», затем по «купили». */
  rows: SourceRow[];
  /** Итог периода; человек в нескольких лидмагнитах считается один раз. */
  totals: { arrived: number; completed: number; purchased: number };
}

export interface SourcesQuery {
  /** Первый день периода по Москве (`YYYY-MM-DD`); `null` — всё время. */
  sinceDay: string | null;
  leadMagnetId?: string;
}

/** Начало дня по Москве: периоды кабинета — календарные дни по Москве. */
export function mskDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+03:00`);
}

/**
 * Первое прохождение человека в лидмагните — его приход: с какой ссылки и когда. Повторные старты («Начать заново»,
 * возврат через меню) нового прихода не создают. Порядок «раньше» — по началу, при равенстве — по id.
 */
export function firstArrivalCondition(arrival: { leadMagnetId: string; linkId: string | null; sinceDay?: string }, personId: AnyColumn): SQL {
  return sql`exists (
    select 1 from ${passages} as arrival
    where arrival.person_id = ${personId}
      and arrival.lead_magnet_id = ${arrival.leadMagnetId}
      and arrival.entry_link_id is not distinct from ${arrival.linkId}::uuid
      ${arrival.sinceDay ? sql`and arrival.started_at >= ${mskDayStart(arrival.sinceDay).toISOString()}::timestamptz` : sql``}
      and not exists (
        select 1 from ${passages} as earlier
        where earlier.person_id = arrival.person_id
          and earlier.lead_magnet_id = arrival.lead_magnet_id
          and (earlier.started_at, earlier.id) < (arrival.started_at, arrival.id)
      )
  )`;
}

/** Отчёт «Откуда пришли»: какой источник сколько людей привёл, сколько из них дошли до конца и купили. */
export async function sourcesReport(db: DatabaseExecutor, query: SourcesQuery): Promise<SourcesReport> {
  // Один человек в одном лидмагните — одна запись: источник и дата его первого прохождения, итог всех его разговоров
  const arrivals = db
    .select({
      personId: passages.personId,
      leadMagnetId: passages.leadMagnetId,
      linkId: sql<string | null>`(array_agg(${passages.entryLinkId} order by ${passages.startedAt}, ${passages.id}))[1]`.as("link_id"),
      arrivedAt: sql<Date>`min(${passages.startedAt})`.as("arrived_at"),
      completed: sql<boolean>`bool_or(${passages.status} = 'completed')`.as("completed"),
      purchased: sql<boolean>`bool_or(${passages.purchasedAt} is not null)`.as("purchased"),
      costUsd: sql<string>`coalesce(sum(${passages.costUsd}), 0)`.as("cost_usd"),
    })
    .from(passages)
    .where(query.leadMagnetId ? eq(passages.leadMagnetId, query.leadMagnetId) : undefined)
    .groupBy(passages.personId, passages.leadMagnetId)
    .as("arrivals");
  const inPeriod = query.sinceDay ? sql`${arrivals.arrivedAt} >= ${mskDayStart(query.sinceDay).toISOString()}::timestamptz` : undefined;
  const leadMagnetName = sql<string>`${leadMagnets.draft} ->> 'name'`;
  const people = (condition?: SQL) =>
    sql<number>`count(distinct ${arrivals.personId}) ${condition ? sql`filter (where ${condition})` : sql``}`.mapWith(Number);
  const counts = {
    arrived: people(),
    completed: people(sql`${arrivals.completed}`),
    purchased: people(sql`${arrivals.purchased}`),
  };

  const [groups, totals, silentLinks] = await Promise.all([
    db
      .select({
        linkId: arrivals.linkId,
        label: entryLinks.label,
        archivedAt: entryLinks.archivedAt,
        leadMagnetId: leadMagnets.id,
        leadMagnetName,
        ...counts,
        costUsd: sql<string>`coalesce(sum(${arrivals.costUsd}), 0)`,
      })
      .from(arrivals)
      .innerJoin(leadMagnets, eq(leadMagnets.id, arrivals.leadMagnetId))
      .leftJoin(entryLinks, eq(entryLinks.id, arrivals.linkId))
      .where(inPeriod)
      .groupBy(arrivals.linkId, entryLinks.id, leadMagnets.id),
    db.select(counts).from(arrivals).where(inPeriod),
    // Действующие метки: без людей за период они тоже нужны — видно, что объявление никого не привело
    db
      .select({ linkId: entryLinks.id, label: entryLinks.label, leadMagnetId: entryLinks.leadMagnetId, leadMagnetName })
      .from(entryLinks)
      .innerJoin(leadMagnets, eq(leadMagnets.id, entryLinks.leadMagnetId))
      .where(
        and(
          isNotNull(entryLinks.label),
          isNull(entryLinks.archivedAt),
          ...(query.leadMagnetId ? [eq(entryLinks.leadMagnetId, query.leadMagnetId)] : []),
        ),
      ),
  ]);

  const rows: SourceRow[] = groups.map((group) => ({
    linkId: group.linkId,
    kind: group.linkId === null ? "none" : group.label === null ? "main" : "label",
    label: group.label,
    archived: group.archivedAt !== null,
    leadMagnetId: group.leadMagnetId,
    leadMagnetName: group.leadMagnetName ?? "",
    arrived: group.arrived,
    completed: group.completed,
    purchased: group.purchased,
    costUsd: Number(group.costUsd),
  }));
  const shown = new Set(rows.map((row) => row.linkId));
  for (const link of silentLinks) {
    if (shown.has(link.linkId)) continue;
    rows.push({
      linkId: link.linkId,
      kind: "label",
      label: link.label,
      archived: false,
      leadMagnetId: link.leadMagnetId,
      leadMagnetName: link.leadMagnetName ?? "",
      arrived: 0,
      completed: 0,
      purchased: 0,
      costUsd: 0,
    });
  }
  // Лучшие сверху; при равенстве — по метке, чтобы порядок не прыгал между открытиями
  rows.sort((a, b) => b.arrived - a.arrived || b.purchased - a.purchased || (a.label ?? "").localeCompare(b.label ?? "", "ru"));

  const [total] = totals;
  return { rows, totals: { arrived: total?.arrived ?? 0, completed: total?.completed ?? 0, purchased: total?.purchased ?? 0 } };
}
