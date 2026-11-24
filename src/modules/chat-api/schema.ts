import { index, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { leadMagnets } from "../lead-magnets/schema";
import { appSchema } from "../platform/app-schema";
import { webChatVisitors } from "../web-chat/schema";

/**
 * Сайты, где чат лидмагнита работает из браузера (виджет и свой чат эксперта): домены и маски поддоменов
 * (`*.example.ru`). Строки нет или список пуст — работает везде. Вне черновика и версий: список действует сразу.
 */
export const chatApiSites = appSchema.table("chat_api_sites", {
  leadMagnetId: uuid("lead_magnet_id")
    .primaryKey()
    .references(() => leadMagnets.id, { onDelete: "cascade" }),
  sites: text("sites").array().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Секретные ключи лидмагнита для сервера эксперта. Хранится только хэш; действует один — без `revokedAt`. */
export const chatApiKeys = appSchema.table(
  "chat_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadMagnetId: uuid("lead_magnet_id")
      .notNull()
      .references(() => leadMagnets.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull().unique(),
    /** Начало ключа для кабинета: по нему эксперт узнаёт, какой ключ стоит у него на сервере. */
    keyStart: text("key_start").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("chat_api_keys_lead_magnet_idx").on(table.leadMagnetId)],
);

/**
 * Посетители сервера эксперта: его id посетителя → посетитель веб-чата. Токен посетителя под шифром приложения: им сервер
 * входит в веб-чат от имени этого человека, браузер его не видит.
 */
export const chatApiVisitors = appSchema.table(
  "chat_api_visitors",
  {
    leadMagnetId: uuid("lead_magnet_id")
      .notNull()
      .references(() => leadMagnets.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    visitorId: uuid("visitor_id")
      .notNull()
      .references(() => webChatVisitors.id, { onDelete: "cascade" }),
    tokenEncrypted: text("token_encrypted").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.leadMagnetId, table.externalId] })],
);
