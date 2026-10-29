import { and, eq, sql } from "drizzle-orm";
import type { ChannelKind } from "../channels/channel";
import type { DatabaseExecutor } from "../platform/db";
import { people, type PersonFact, type PersonFieldValue } from "./schema";

export type Person = typeof people.$inferSelect;

/**
 * Находит человека по боту и его id в мессенджере; нет — заводит. Строка блокируется до конца транзакции:
 * сообщения одного человека разбираются по очереди. Имя обновляется, если мессенджер прислал новое.
 */
export async function upsertPerson(
  db: DatabaseExecutor,
  input: { channel: ChannelKind; botId: string; externalUserId: string; displayName?: string | null; at: Date },
): Promise<Person> {
  const displayName = input.displayName?.trim() || null;
  await db
    .insert(people)
    .values({
      channel: input.channel,
      botId: input.botId,
      externalUserId: input.externalUserId,
      displayName,
      lastInboundAt: input.at,
    })
    .onConflictDoUpdate({
      target: [people.botId, people.externalUserId],
      set: {
        lastInboundAt: input.at,
        ...(displayName && { displayName }),
      },
    });
  const [person] = await db
    .select()
    .from(people)
    .where(and(eq(people.botId, input.botId), eq(people.externalUserId, input.externalUserId)))
    .for("update");
  if (!person) throw new Error("Запись человека не создалась");
  return person;
}

export async function getPerson(db: DatabaseExecutor, id: string): Promise<Person | null> {
  const [person] = await db.select().from(people).where(eq(people.id, id));
  return person ?? null;
}

/**
 * Дописывает факты и значения полей в карточку человека. `source` — где это узнали (id прохождения).
 * Тот же факт из того же источника второй раз не пишется: повтор хода не задваивает карточку.
 */
export async function rememberAboutPerson(
  db: DatabaseExecutor,
  personId: string,
  update: { facts: string[]; fieldValues: Record<string, PersonFieldValue>; source: string; at: Date },
): Promise<void> {
  const facts: PersonFact[] = update.facts.map((text) => ({ text, at: update.at.toISOString(), source: update.source }));
  await db
    .update(people)
    .set({
      facts: sql`${people.facts} || coalesce((
        select jsonb_agg(fact) from jsonb_array_elements(${JSON.stringify(facts)}::jsonb) as fact
        where not exists (
          select 1 from jsonb_array_elements(${people.facts}) as known
          where known->>'text' = fact->>'text' and known->>'source' = fact->>'source'
        )
      ), '[]'::jsonb)`,
      fieldValues: sql`${people.fieldValues} || ${JSON.stringify(update.fieldValues)}::jsonb`,
    })
    .where(eq(people.id, personId));
}

export async function markPersonBlocked(db: DatabaseExecutor, personId: string, at: Date): Promise<void> {
  await db.update(people).set({ blockedAt: at }).where(eq(people.id, personId));
}

export async function markPersonUnblocked(db: DatabaseExecutor, personId: string): Promise<void> {
  await db.update(people).set({ blockedAt: null }).where(eq(people.id, personId));
}
