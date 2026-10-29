import { integer, jsonb, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { appSchema } from "./app-schema";

/** Цепочка старых напоминаний. Не читается с перехода на сценарии SDK (S6); колонку удалит уборка S10. */
export interface ReminderChainSettings {
  steps: Array<{ afterMinutes: number } | { dailyAt: string[] }>;
  quietHours: [string, string];
  giveUpAfterDays: number;
}

/** Настройки приложения. Всегда одна строка: `id = 1`. */
export const appSettings = appSchema.table("app_settings", {
  id: integer("id").primaryKey().default(1),
  /** Устарело: сообщения первым ведёт сценарий SDK. Для отката на старую версию у прода значение остаётся. */
  reminderChain: jsonb("reminder_chain").$type<ReminderChainSettings>(),
  dailyLimitUsd: numeric("daily_limit_usd", { precision: 12, scale: 6 }).notNull().default("1.00"),
  monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 12, scale: 6 }),
  budgetAcknowledgedAt: timestamp("budget_acknowledged_at", { withTimezone: true }),
  maxMessageChars: integer("max_message_chars").notNull().default(2000),
  privacyPolicyUrl: text("privacy_policy_url"),
  alertChatId: text("alert_chat_id"),
});
