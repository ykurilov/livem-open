import { sql } from "drizzle-orm";
import { index, integer, timestamp, uuid } from "drizzle-orm/pg-core";
import { people } from "../people/schema";
import { appSchema } from "../platform/app-schema";

/**
 * Переписка во «Входящих»: одна на человека. Счётчик растёт сам — триггер базы на каждое входящее
 * с `route = inbox`, откуда бы оно ни пришло (после завершения, режим «ничего», упавший ход).
 * Ответ эксперта обнуляет счётчик.
 */
export const inboxThreads = appSchema.table(
  "inbox_threads",
  {
    personId: uuid("person_id")
      .primaryKey()
      .references(() => people.id),
    unansweredCount: integer("unanswered_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** Когда эксперт ответил последний раз. */
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
  },
  (table) => [index("inbox_threads_unanswered").on(table.lastMessageAt).where(sql`${table.unansweredCount} > 0`)],
);
