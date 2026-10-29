import { and, isNull, sql, type SQL } from "drizzle-orm";
import { bots } from "../channels/schema";
import { listPeopleFilterOptions, peopleFilterCondition, type PeopleFilter, type PeopleFilterOptions } from "../people/filters";
import { people } from "../people/schema";
import type { DatabaseExecutor } from "../platform/db";
import { mailingRecipients } from "./schema";

/** Кто получит рассылку: подходит под фильтр базы, не посреди лидмагнита, не заблокировал бота, бот не удалён. */
function recipientCondition(filter: PeopleFilter): SQL | undefined {
  return and(
    peopleFilterCondition({ ...filter, withoutActivePassage: true }),
    isNull(people.blockedAt),
    sql`exists (select 1 from ${bots} where ${bots.id} = ${people.botId} and ${bots.deletedAt} is null)`,
  );
}

/** Варианты фильтра «Кому»: как в «Базе», но без удалённых ботов — через них рассылку не отправить. */
export async function listMailingFilterOptions(db: DatabaseExecutor): Promise<PeopleFilterOptions> {
  const [options, activeBots] = await Promise.all([
    listPeopleFilterOptions(db),
    db.select({ id: bots.id }).from(bots).where(isNull(bots.deletedAt)),
  ]);
  const active = new Set(activeBots.map((bot) => bot.id));
  return { ...options, bots: options.bots.filter((bot) => active.has(bot.id)) };
}

/** Сколько человек получат рассылку, если запустить её сейчас. */
export async function countRecipients(db: DatabaseExecutor, filter: PeopleFilter): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(people).where(recipientCondition(filter));
  return row?.count ?? 0;
}

/** Фиксирует получателей при старте: кто придёт или начнёт лидмагнит позже, рассылку уже не получит. */
export async function fixRecipients(db: DatabaseExecutor, mailingId: string, filter: PeopleFilter): Promise<number> {
  const inserted = await db
    .insert(mailingRecipients)
    .select(
      db
        .select({
          mailingId: sql<string>`${mailingId}::uuid`.as("mailing_id"),
          personId: people.id,
          botId: people.botId,
          outboundMessageId: sql<string | null>`null::uuid`.as("outbound_message_id"),
          error: sql<string | null>`null::text`.as("error"),
          botDownSince: sql<Date | null>`null::timestamptz`.as("bot_down_since"),
        })
        .from(people)
        .where(recipientCondition(filter)),
    )
    .onConflictDoNothing()
    .returning({ personId: mailingRecipients.personId });
  return inserted.length;
}
