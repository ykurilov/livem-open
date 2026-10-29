import type { DatabaseConnection } from "./db";

export interface HealthChecks {
  checkDatabase(): Promise<boolean>;
  checkQueue(): Promise<boolean>;
}

async function safely(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

/** Обработчик `GET /api/health`: 200 `{ok, db, queue}`, а если что-то не отвечает — 503. */
export function createHealthHandler(checks: HealthChecks): () => Promise<Response> {
  return async () => {
    const [db, queue] = await Promise.all([safely(checks.checkDatabase), safely(checks.checkQueue)]);
    const ok = db && queue;
    return Response.json({ ok, db, queue }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  };
}

export async function checkDatabase(connection: Pick<DatabaseConnection, "pool">): Promise<boolean> {
  try {
    await connection.pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
