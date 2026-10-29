import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { connectDatabase, migrateDatabase, type DatabaseConnection } from "@/modules/platform/db";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_PREFIX } from "./test-database-url";

export interface TestDatabase extends DatabaseConnection {
  /** Адрес этой базы — для кода, которому нужна строка подключения (очередь, хранилище SDK). */
  url: string;
  /** Закрывает соединения и удаляет базу. */
  drop(): Promise<void>;
}

/**
 * Отдельная база на каждый тест-файл, с применёнными миграциями приложения.
 * Схема `app` в коде записана явно, поэтому изоляция — целой базой, а не схемой.
 */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `${TEST_DATABASE_PREFIX}${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: TEST_ADMIN_DATABASE_URL, max: 1 });
  await admin.query(`create database "${name}"`);
  await admin.end();

  const url = new URL(TEST_ADMIN_DATABASE_URL);
  url.pathname = `/${name}`;
  const connection = connectDatabase(url.toString(), { poolSize: 4 });
  if (options.migrate !== false) await migrateDatabase(connection);

  return {
    ...connection,
    url: url.toString(),
    async drop() {
      await connection.close();
      const dropper = new Pool({ connectionString: TEST_ADMIN_DATABASE_URL, max: 1 });
      try {
        await dropper.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
