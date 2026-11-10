import { sql } from "drizzle-orm";
import { index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { leadMagnets } from "../lead-magnets/schema";
import { appSchema } from "../platform/app-schema";

export type RoleSwapStatus = "active" | "finished";
/** `client_left` — агент-клиент закончил разговор сам; `submitted` — эксперт нажал «Закончить и разобрать». */
export type RoleSwapFinishedReason = "client_left" | "submitted";
/** Отдача ответов эксперта на разбор конструктору. */
export type RoleSwapReview = "preparing" | "ready" | "failed";
/** Версия черновика и нода на момент ответа эксперта. */
export interface RoleSwapAnswerMark {
  draftVersionId: string;
  stageId?: string;
}

/**
 * Разговор «Поменяемся ролями»: агент играет клиента лидмагнита, эксперт отвечает за консультанта. Чат живёт в модуле
 * чата (`chat_id`); здесь — карточка клиента, состояние и отметки ответов эксперта. «Начать заново» не удаляет прежний
 * разговор, а ставит ему `replaced_at`: его карточка нужна, чтобы следующий клиент был другим.
 */
export const roleSwapConversations = appSchema.table(
  "role_swap_conversations",
  {
    chatId: text("chat_id").primaryKey(),
    leadMagnetId: uuid("lead_magnet_id")
      .notNull()
      .references(() => leadMagnets.id, { onDelete: "cascade" }),
    /** Поле «Кто клиент». */
    clientBrief: text("client_brief"),
    /** Карточка клиента: придумана при старте и не меняется. */
    clientCard: text("client_card").notNull(),
    /** Тема бота для агента-клиента: название и описание лидмагнита на момент старта. */
    topic: text("topic").notNull(),
    status: text("status").$type<RoleSwapStatus>().notNull(),
    finishedReason: text("finished_reason").$type<RoleSwapFinishedReason>(),
    review: text("review").$type<RoleSwapReview>(),
    /** `{ [id реплики эксперта]: отметка }`. */
    answerMarks: jsonb("answer_marks").$type<Record<string, RoleSwapAnswerMark>>().notNull().default({}),
    /** `{ [id реплики клиента]: нода }` — где разговор после этой реплики, по проверке перехода. */
    clientStages: jsonb("client_stages").$type<Record<string, string>>().notNull().default({}),
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (table) => [
    // Один текущий разговор на лидмагнит
    uniqueIndex("role_swap_conversations_current").on(table.leadMagnetId).where(sql`${table.replacedAt} is null`),
    index("role_swap_conversations_lead_created").on(table.leadMagnetId, table.createdAt),
  ],
);
