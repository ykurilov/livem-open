import { pgSchema } from "drizzle-orm/pg-core";

/** Схема PostgreSQL, в которой лежат все таблицы приложения. Переписки — `agent_chat`, очередь — `pgboss`. */
export const appSchema = pgSchema("app");
