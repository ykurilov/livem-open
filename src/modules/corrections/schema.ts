import { sql } from "drizzle-orm";
import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { leadMagnets } from "../lead-magnets/schema";
import { appSchema } from "../platform/app-schema";
import type { AnswerKind, CorrectionAgentRole, CorrectionContextLine, CorrectionOutcome, CorrectionSource, CorrectionStatus } from "./types";

/**
 * Правки ответов агента экспертом: «было», «стало», почему и кусок разговора перед ответом. Чат может исчезнуть —
 * правка остаётся (у `chat_id` нет внешнего ключа). Разобранная правка не правится и не удаляется: история разбора.
 */
export const answerCorrections = appSchema.table(
  "answer_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadMagnetId: uuid("lead_magnet_id")
      .notNull()
      .references(() => leadMagnets.id, { onDelete: "cascade" }),
    source: text("source").$type<CorrectionSource>().notNull(),
    agentRole: text("agent_role").$type<CorrectionAgentRole>().notNull(),
    chatId: text("chat_id").notNull(),
    originalMessageId: text("original_message_id").notNull(),
    correctedMessageId: text("corrected_message_id").notNull(),
    answerKind: text("answer_kind").$type<AnswerKind>().notNull(),
    originalText: text("original_text").notNull(),
    correctedText: text("corrected_text").notNull(),
    reason: text("reason"),
    context: jsonb("context").$type<CorrectionContextLine[]>().notNull(),
    actions: jsonb("actions").$type<string[]>().notNull(),
    stageId: text("stage_id"),
    programDay: integer("program_day"),
    draftVersionId: uuid("draft_version_id").notNull(),
    status: text("status").$type<CorrectionStatus>().notNull(),
    outcome: text("outcome").$type<CorrectionOutcome>(),
    resolvedVersionId: uuid("resolved_version_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    announcedAt: timestamp("announced_at", { withTimezone: true }),
    // Время записи, а не начала транзакции: правки одной вставки идут по порядку
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (table) => [
    index("answer_corrections_lead_status").on(table.leadMagnetId, table.status, table.createdAt),
    // Одна неразобранная правка на ответ
    uniqueIndex("answer_corrections_pending_answer").on(table.originalMessageId).where(sql`${table.status} = 'pending'`),
    index("answer_corrections_chat").on(table.chatId),
  ],
);

/**
 * Правки ответа в чате, уже учтённые журналом правок: по ним хук правки и сверка с лентой чата не записывают одну
 * правку дважды и не возвращают убранную. Отметка остаётся и после «Убрать правку».
 */
export const answerEditReceipts = appSchema.table(
  "answer_edit_receipts",
  {
    /** Ответ с текстом эксперта, который создал модуль чата. */
    messageId: text("message_id").primaryKey(),
    leadMagnetId: uuid("lead_magnet_id")
      .notNull()
      .references(() => leadMagnets.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (table) => [index("answer_edit_receipts_chat").on(table.chatId)],
);
