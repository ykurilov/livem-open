import { sql } from "drizzle-orm";
import { date, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ChannelKind, ContactSource } from "../channels/channel";
import { bots } from "../channels/schema";
import { appSchema } from "../platform/app-schema";

export const FIELD_TYPES = ["boolean", "choice", "number", "text"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Словарь полей базы: что консультант может узнать о человеке и записать в его карточку. */
export const fields = appSchema.table(
  "fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    type: text("type").$type<FieldType>().notNull(),
    /** Варианты для `choice`; у остальных пусто. */
    options: text("options").array().notNull().default(sql`'{}'::text[]`),
    description: text("description").notNull().default(""),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Имя уникально без учёта регистра среди неудалённых полей
  (table) => [uniqueIndex("fields_name_lower").on(sql`lower(${table.name})`).where(sql`${table.deletedAt} is null`)],
);

export type PersonFieldValue = string | number | boolean;

/** Свободный факт о человеке. `source` — прохождение, в котором его запомнили. */
export interface PersonFact {
  text: string;
  at: string;
  source: string;
  /** Id факта сценария SDK (`f` и восемь цифр по тексту). У фактов, записанных до сценариев, нет — считается по тексту. */
  id?: string;
  /** Чат и сценарий (id лидмагнита), где агент записал факт; до сценариев не записывались. */
  chatId?: string;
  flowId?: string;
}

/** Запись базы: один аккаунт в одном мессенджере. Её id — владелец чатов SDK этого человека. */
export const people = appSchema.table(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: text("channel").$type<ChannelKind>().notNull(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    externalUserId: text("external_user_id").notNull(),
    displayName: text("display_name"),
    /** Последнее записанное значение каждого поля: `{ fieldId: value }`. */
    fieldValues: jsonb("field_values").$type<Record<string, PersonFieldValue>>().notNull().default({}),
    facts: jsonb("facts").$type<PersonFact[]>().notNull().default([]),
    /** Часовой пояс человека (IANA): консультант узнаёт его между делом и действует он во всех прохождениях. Пусто — Москва. */
    timeZone: text("time_zone"),
    /** Откуда человек, если первым пришло не сообщение боту, а контакт из другого сервиса. Пусто — пришёл сам или по ссылке. */
    source: text("source").$type<ContactSource>(),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    /** День (по Москве), когда ушёл автоответ «скоро свяжусь»: не чаще раза в сутки. */
    lastAutoreplyOn: date("last_autoreply_on", { mode: "string" }),
    /** День (по Москве), когда эксперт ответил сам: в этот день автоответа нет. */
    lastManualReplyOn: date("last_manual_reply_on", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("people_bot_external_user").on(table.botId, table.externalUserId)],
);
