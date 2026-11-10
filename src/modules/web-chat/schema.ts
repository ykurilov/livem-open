import { index, integer, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "../platform/app-schema";
import type { WebPushSubscription } from "./push";

/** Посетители веб-чата. `id` — он же `external_user_id` человека на боте веб-чата. */
export const webChatVisitors = appSchema.table(
  "web_chat_visitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Код ссылки, по которой посетитель открыл чат последний раз: туда ведёт уведомление. */
    lastCode: text("last_code"),
    pushSubscription: jsonb("push_subscription").$type<WebPushSubscription>(),
    /** Когда открытая страница последний раз спрашивала новые сообщения; страница скрыта — пусто. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /**
     * Одноразовый код входа для веб-приложения с экрана «Домой» (оно начинает без cookie браузера). Хеш — для поиска,
     * шифр — чтобы манифест отдавал тот же код, пока его не использовали.
     */
    resumeCodeHash: text("resume_code_hash"),
    resumeCodeEncrypted: text("resume_code_encrypted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("web_chat_visitors_resume_code_hash").on(table.resumeCodeHash)],
);

/** Токены посетителя из cookie, по одному на браузер или веб-приложение; в базе только хеш. */
export const webChatTokens = appSchema.table(
  "web_chat_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    visitorId: uuid("visitor_id")
      .notNull()
      .references(() => webChatVisitors.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("web_chat_tokens_visitor").on(table.visitorId)],
);

/** Счётчики ограничений веб-чата по окнам времени: переживают перезапуск и общие для всех процессов. */
export const webChatLimits = appSchema.table(
  "web_chat_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.key, table.windowStart] }), index("web_chat_limits_window").on(table.windowStart)],
);
