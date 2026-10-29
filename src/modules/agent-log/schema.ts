import { bigserial, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { leadMagnets } from "../lead-magnets/schema";
import { appSchema } from "../platform/app-schema";
import type { AgentLogAgent, AgentLogEntry, AgentLogSource } from "./types";

/** Ход агента в журнале: от сообщения (или запуска) до конца ответа. Старше 30 дней удаляется. */
export const agentLogTurns = appSchema.table(
  "agent_log_turns",
  {
    id: uuid("id").primaryKey(),
    leadMagnetId: uuid("lead_magnet_id")
      .notNull()
      .references(() => leadMagnets.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    agent: text("agent").$type<AgentLogAgent>().notNull(),
    source: text("source").$type<AgentLogSource>(),
    personId: uuid("person_id"),
    personLabel: text("person_label"),
    channel: text("channel"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("agent_log_turns_lead_started").on(table.leadMagnetId, table.startedAt), index("agent_log_turns_started").on(table.startedAt)],
);

/** Вызов модели или инструмента внутри хода; подробности — в `data` (уже без секретов). */
export const agentLogEntries = appSchema.table(
  "agent_log_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => agentLogTurns.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AgentLogEntry["kind"]>().notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    data: jsonb("data").$type<AgentLogEntry>().notNull(),
  },
  (table) => [index("agent_log_entries_turn").on(table.turnId, table.id)],
);
