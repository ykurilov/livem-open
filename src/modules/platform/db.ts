import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { requireEnv } from "./env";

export type Database = NodePgDatabase;

/** База или открытая транзакция: функции модулей принимают и то и другое. */
export type DatabaseExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseConnection {
  db: Database;
  pool: Pool;
  close(): Promise<void>;
}

/**
 * Сколько ждать свободного соединения пула, мс. Дольше — ошибка: задача очереди уходит в повтор, страница — в ошибку,
 * а не висят без конца, пока соединения держат медленные мессенджеры.
 */
const CONNECTION_WAIT_MS = 15_000;

export function connectDatabase(connectionString: string, options: { poolSize?: number; connectionWaitMs?: number } = {}): DatabaseConnection {
  const pool = new Pool({ connectionString, max: options.poolSize ?? 10, connectionTimeoutMillis: options.connectionWaitMs ?? CONNECTION_WAIT_MS });
  return { db: drizzle(pool), pool, close: () => pool.end() };
}

// Соединение одно на процесс. В `next dev` модули перезагружаются, поэтому оно лежит в globalThis.
const shared = globalThis as typeof globalThis & { livemDatabase?: DatabaseConnection };

export function getDatabase(): DatabaseConnection {
  return (shared.livemDatabase ??= connectDatabase(requireEnv("DATABASE_URL")));
}

export const MIGRATIONS_FOLDER = "drizzle";

/** Создаёт схему `app` и применяет миграции приложения. */
export async function migrateDatabase(connection: DatabaseConnection, migrationsFolder = MIGRATIONS_FOLDER): Promise<void> {
  await connection.pool.query("create schema if not exists app");
  await migrate(connection.db, { migrationsFolder, migrationsSchema: "app", migrationsTable: "__migrations" });
}

const UNIQUE_VIOLATION = "23505";

/** Нарушена уникальность. Драйвер базы кладёт код ошибки либо в саму ошибку, либо (через drizzle) в `cause`. */
export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } }) ?? {};
  return code.code === UNIQUE_VIOLATION || code.cause?.code === UNIQUE_VIOLATION;
}
