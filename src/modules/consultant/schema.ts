import type { FlowTransitionEvent } from "@ykurilov/agent-chat-flows";
import { integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "../platform/app-schema";
import { leadMagnets } from "../lead-magnets/schema";

/** Кто перевёл на этап: консультант по условию или приложение по дню программы. */
export type StageChangedBy = "model" | "day";

export interface StageHistoryEntry {
  stageId: string;
  at: string;
  /** Причина перехода одной фразой. У переходов, записанных до программы, её нет. */
  reason?: string;
  /** У переходов, записанных до программы, не задано: это переход консультанта. */
  by?: StageChangedBy;
  /** Ход, в котором приложение сменило этап по дню: его повтор после сбоя знает, что этап сменился сам. */
  turnId?: string;
  /** Кто решил переход в сценарии SDK: агент с судьёй, судья после ответа, таймер, данные, событие. До сценариев нет. */
  decidedBy?: FlowTransitionEvent["decidedBy"];
  /** Уверенность судьи, 0…1. */
  probability?: number;
  /** День программы в момент перехода; у лидмагнита без программы нет. */
  day?: number;
}

/** Причина отказа в продаже. */
export const SALE_REASONS = ["price", "time", "doubt", "not_interested"] as const;
export type SaleReason = (typeof SALE_REASONS)[number];

/** Ответ человека на предложение продукта (`passages.sale_answer`). */
export interface SaleAnswer {
  reason: SaleReason;
  /** Твёрдое «нет»: больше не продаём. Мягкое — разбираем один раз. */
  firm: boolean;
  /** Мягкое «нет» уже разобрано: на повторное — возврат к помощи без продажи. */
  softHandled: boolean;
  /** Номер дня, когда прозвучало последнее предложение (повтор — не больше одного раза в последний день). */
  lastOfferDay: number | null;
}

/** Попутные задачи прохождения (`passages.side_tasks`). */
export interface PassageSideTasks {
  /** Решённые задачи: больше не всплывают. */
  done?: string[];
  /** На каком по счёту сообщении человека консультант задал последний попутный вопрос. */
  lastAskedAtMessage?: number;
  /** Сколько раз консультант задал вопрос каждой задачи: после `SIDE_TASK_MAX_ASKS` задача больше не всплывает. */
  asks?: Record<string, number>;
}

/** Чем кончился разговор: согласился с итогом, отказался или ушёл. */
export const DIALOG_OUTCOMES = ["agreed", "declined", "left"] as const;
export type DialogOutcome = (typeof DIALOG_OUTCOMES)[number];

/** Итог разговора от `finish_dialog`. */
export interface DialogSummary {
  goal: string;
  stuckAt: string;
  chosenStep: string;
  /** У итогов, записанных до появления исхода, его нет. */
  outcome?: DialogOutcome;
  /** Короткий ответ на вопрос из последней реплики человека. */
  answer?: string;
}

/** Последнее сообщение, которое пишет приложение, а не модель. */
export interface AppClosing {
  answer: string;
  farewell: string;
}

/**
 * Человек согласился, и прощание задано — последнее сообщение собирает приложение: `answer` из finish_dialog и прощание.
 * Свой текст модели в этом ходе человеку не уходит. Иначе — `null`, последний ответ пишет модель.
 */
export function appClosingAfter(summary: DialogSummary | null | undefined, farewellMessage: string): AppClosing | null {
  const farewell = farewellMessage.trim();
  if (summary?.outcome !== "agreed" || !farewell) return null;
  return { answer: summary.answer?.trim() ?? "", farewell };
}

export function appClosingText(closing: AppClosing): string {
  return [closing.answer, closing.farewell].filter(Boolean).join("\n\n");
}

export type FieldValue = string | number | boolean;

/**
 * Состояние тестового разговора эксперта с консультантом. В базу людей ничего не пишет:
 * факты и значения полей живут только здесь.
 */
export const previewConversations = appSchema.table("preview_conversations", {
  chatId: text("chat_id").primaryKey(),
  leadMagnetId: uuid("lead_magnet_id")
    .notNull()
    .references(() => leadMagnets.id, { onDelete: "cascade" }),
  currentStageId: text("current_stage_id"),
  stageHistory: jsonb("stage_history").$type<StageHistoryEntry[]>().notNull().default([]),
  facts: jsonb("facts").$type<string[]>().notNull().default([]),
  fieldValues: jsonb("field_values").$type<Record<string, FieldValue>>().notNull().default({}),
  summary: jsonb("summary").$type<DialogSummary>(),
  /** Не используется: часы тестового чата и день хранит сценарий SDK (`advanceTestClock`). Колонку уберёт отдельная миграция. */
  dayOffset: integer("day_offset").notNull().default(0),
  /** Состояние программы тестового разговора — как у прохождения: пояс, сообщения эксперта, продажа, попутные задачи. */
  timeZone: text("time_zone"),
  personMessageCount: integer("person_message_count").notNull().default(0),
  saleAnswer: jsonb("sale_answer").$type<SaleAnswer>(),
  sideTasks: jsonb("side_tasks").$type<PassageSideTasks>().notNull().default({}),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
