import { sql } from "drizzle-orm";
import { index, integer, jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PeopleFilter } from "../people/filters";
import { appSchema } from "../platform/app-schema";

export const MAILING_STATUSES = ["draft", "scheduled", "sending", "done", "cancelled"] as const;
export type MailingStatus = (typeof MAILING_STATUSES)[number];

/**
 * Рассылка по базе. Итоги отчёта (ушло, не доставлено, ответили) считаются по получателям и исходящим,
 * а не хранятся: «ответили» растёт ещё 7 дней после отправки.
 */
export const mailings = appSchema.table("mailings", {
  id: uuid("id").primaryKey().defaultRandom(),
  text: text("text").notNull(),
  /** Картинка на диске (`/app/data/uploads`). */
  imagePath: text("image_path"),
  filter: jsonb("filter").$type<PeopleFilter>().notNull().default({}),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  status: text("status").$type<MailingStatus>().notNull().default("draft"),
  /** Кому ушла последняя проба «Отправить себе» — выбирается в следующий раз сам. */
  testPersonId: uuid("test_person_id"),
  /** Сколько людей зафиксировано при старте. */
  recipientCount: integer("recipient_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  /**
   * Когда ждать следующую порцию. Порция раньше срока — дубль цепочки, она ничего не делает;
   * срок давно прошёл — задача потерялась, подмётчик ставит её заново.
   */
  batchDueAt: timestamp("batch_due_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Получатели, зафиксированные при старте. Пока `outbound_message_id` и `error` пусты — человек ждёт своей порции.
 * `error` — не дошло до очереди отправки (бот отключён).
 */
export const mailingRecipients = appSchema.table(
  "mailing_recipients",
  {
    mailingId: uuid("mailing_id")
      .notNull()
      .references(() => mailings.id),
    personId: uuid("person_id").notNull(),
    botId: uuid("bot_id").notNull(),
    outboundMessageId: uuid("outbound_message_id"),
    error: text("error"),
    /** С какого момента бот этого получателя не в порядке. Через 15 минут без восстановления — «не доставлено». */
    botDownSince: timestamp("bot_down_since", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.mailingId, table.personId] }),
    index("mailing_recipients_waiting")
      .on(table.mailingId, table.botId)
      .where(sql`${table.outboundMessageId} is null and ${table.error} is null`),
  ],
);
