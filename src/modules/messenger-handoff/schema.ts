import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bots } from "../channels/schema";
import { passages } from "../conversations/schema";
import { appSchema } from "../platform/app-schema";

/**
 * Переход разговора из веб-чата в мессенджер: одна строка на прохождение. Консультант показал кнопки — строка есть;
 * человек нажал «Старт» в боте с кодом `code` — `taken_at`: с этого момента он сам — аккаунт мессенджера, а разговор
 * (чат SDK, память, этап, сроки) — прежний.
 */
export const messengerHandoffs = appSchema.table(
  "messenger_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    passageId: uuid("passage_id")
      .notNull()
      .references(() => passages.id),
    /** Человек (`people.id`), который был в веб-чате. После перехода — та же строка, уже с аккаунтом мессенджера. */
    personId: uuid("person_id").notNull(),
    /** Посетитель веб-чата: страница чата находит по нему переписку и показывает, где разговор продолжается. */
    visitorId: uuid("visitor_id").notNull(),
    /** Код в стартовой ссылке бота: 24 знака `A-Za-z0-9`, подходит Telegram, ВК и Max. */
    code: text("code").notNull(),
    offeredAt: timestamp("offered_at", { withTimezone: true }).notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    /** Бот, в котором человек нажал «Старт». */
    takenBotId: uuid("taken_bot_id").references(() => bots.id),
    /** Входящее «Старт», которым перешёл: по нему разбор входящих доводит продолжение разговора. */
    takenInboundId: uuid("taken_inbound_id"),
    /** Сценарий получил событие `messenger_handoff`: повтор задачи второго не шлёт. */
    signaledAt: timestamp("signaled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("messenger_handoffs_passage").on(table.passageId),
    uniqueIndex("messenger_handoffs_code").on(table.code),
    index("messenger_handoffs_visitor").on(table.visitorId),
    index("messenger_handoffs_person").on(table.personId),
  ],
);

export type MessengerHandoffRow = typeof messengerHandoffs.$inferSelect;
