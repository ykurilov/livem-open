import { Pool } from "pg";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_PREFIX } from "./test-database-url";

// Перед прогоном проверяем, что PostgreSQL жив, и убираем базы, оставшиеся от оборванных прогонов
export default async function setup() {
  const pool = new Pool({ connectionString: TEST_ADMIN_DATABASE_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ datname: string }>(
      "select datname from pg_database where datname like $1",
      [`${TEST_DATABASE_PREFIX}%`],
    );
    for (const { datname } of rows) await pool.query(`drop database if exists "${datname}" with (force)`);
  } catch (failure) {
    throw new Error(
      "PostgreSQL для тестов недоступен. Запустите: docker compose -f docker-compose.dev.yml up -d postgres. " +
        `Причина: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  } finally {
    await pool.end();
  }
}
