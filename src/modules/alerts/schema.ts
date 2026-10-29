import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "../platform/app-schema";

export const ALERT_KINDS = [
  "budget_50",
  "budget_80",
  "budget_100",
  "budget_200",
  "model_failures",
  "bot_error",
  "delivery_failed",
  "turn_failed",
  "provider_outage",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Журнал отправленных тревог: по нему понятно, что уже сообщали и что повторять не нужно. */
export const alerts = appSchema.table(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<AlertKind>().notNull(),
    /** `YYYY-MM` для бюджета; для остальных — то, к чему относится тревога (например, id бота). Пустая строка — «одна на всё». */
    period: text("period").notNull().default(""),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("alerts_kind_period").on(table.kind, table.period)],
);
