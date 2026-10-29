import { index, integer, numeric, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { passages } from "../conversations/schema";
import { appSchema } from "../platform/app-schema";

/** `program_message` — сообщение первым в программе: деньги уже в `chatCost`, запись нужна только для отчёта. */
export const MODEL_USAGE_KINDS = ["reminder_text", "program_message"] as const;
export type ModelUsageKind = (typeof MODEL_USAGE_KINDS)[number];

/** Расход на запросы к модели мимо сервиса SDK (тексты напоминаний): их нет в журнале `agent_chat.usage_records`. */
export const modelUsage = appSchema.table(
  "model_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<ModelUsageKind>().notNull(),
    passageId: uuid("passage_id").references(() => passages.id),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("model_usage_created").on(table.createdAt)],
);

/** Сколько ходов консультанта подряд закончились сбоем модели. Всегда одна строка: `id = 1`. */
export const modelHealth = appSchema.table("model_health", {
  id: integer("id").primaryKey().default(1),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
});
