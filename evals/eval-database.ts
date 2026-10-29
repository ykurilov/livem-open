// Отдельная база на каждый сценарий eval: только локальный PostgreSQL, боевую базу не трогает.
import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { connectDatabase, migrateDatabase, type DatabaseConnection } from "@/modules/platform/db";

export interface EvalDatabase extends DatabaseConnection {
  url: string;
  /** Закрывает соединения и удаляет базу. */
  drop(): Promise<void>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Админский адрес локального PostgreSQL (docker-compose.dev.yml). Чужой хост — отказ. */
export function evalAdminUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.EVAL_DATABASE_ADMIN_URL ?? "postgres://livem:livem@localhost:55439/postgres";
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Eval работает только с локальной базой, а задан хост ${host}`);
  return url;
}

// Своя приставка у каждой копии репозитория, как у тестовых баз
const checkoutTag = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 6);
export const EVAL_DATABASE_PREFIX = `livem_eval_${checkoutTag}_`;

export async function createEvalDatabase(label: string): Promise<EvalDatabase> {
  const adminUrl = evalAdminUrl();
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20);
  const name = `${EVAL_DATABASE_PREFIX}${safeLabel}_${randomBytes(3).toString("hex")}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const connection = connectDatabase(url.toString(), { poolSize: 6 });
  await migrateDatabase(connection);

  return {
    ...connection,
    url: url.toString(),
    async drop() {
      await connection.close();
      const dropper = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await dropper.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
