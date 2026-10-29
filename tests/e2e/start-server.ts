// Сервер для сквозных проверок: пустая база с миграциями, `next dev` и работник очереди с подставными моделью и мессенджером.
// Страницы собираются заранее: иначе первая сборка страницы в одном тесте перезагружает вкладку соседнего.
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { seal } from "@/auth/core/cookie-seal";
import { connectDatabase, migrateDatabase } from "@/modules/platform/db";
import { TEST_ADMIN_DATABASE_URL } from "../integration/test-database-url";
import {
  E2E_BASE_URL,
  E2E_COOKIE_SECRET,
  E2E_DATABASE_NAME,
  E2E_EMAIL,
  E2E_PORT,
  E2E_READY_LINE,
  e2eDatabaseUrl,
  e2eServerEnv,
} from "./e2e-env";

const admin = new Pool({ connectionString: TEST_ADMIN_DATABASE_URL, max: 1 });
await admin.query(`drop database if exists "${E2E_DATABASE_NAME}" with (force)`);
await admin.query(`create database "${E2E_DATABASE_NAME}"`);
await admin.end();

const connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 1 });
await migrateDatabase(connection);
await connection.close();

// Собранные при прогреве страницы остаются в памяти до конца прогона (`onDemandEntries` в next.config.mjs)
const env = { ...process.env, ...e2eServerEnv(), E2E_KEEP_DEV_PAGES: "1" };
const server = spawn("pnpm", ["exec", "next", "dev", "--webpack", "-p", String(E2E_PORT)], { stdio: "inherit", env });
const worker = spawn("pnpm", ["exec", "tsx", "src/worker/index.ts"], { stdio: "inherit", env });
const stop = () => {
  server.kill("SIGTERM");
  worker.kill("SIGTERM");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.on("exit", (code) => {
  worker.kill("SIGTERM");
  process.exit(code ?? 0);
});
worker.on("exit", (code) => {
  if (code) console.error(`Работник остановился с кодом ${code}`);
});

async function warmUp(): Promise<void> {
  while (!(await fetch(`${E2E_BASE_URL}/login`).then((response) => response.ok, () => false)))
    await new Promise((resolve) => setTimeout(resolve, 500));
  const session = {
    user: { id: "e2e-warmup", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
  };
  const headers = { cookie: `auth_session=${await seal(session, E2E_COOKIE_SECRET)}` };
  const missing = "00000000-0000-0000-0000-000000000000";
  const pages = ["/", "/bots", "/settings", "/people", `/people/${missing}`, "/fields", "/videos", "/inbox", "/mailings", "/mailings/new", `/mailings/${missing}`, `/lead-magnets/${missing}`, `/lead-magnets/${missing}/publish`, `/bots/${missing}`, "/api/preview/models", "/api/constructor/models"];
  // Страницы независимы: собираются одновременно
  await Promise.all([
    ...pages.map((path) => fetch(`${E2E_BASE_URL}${path}`, { headers }).then((response) => response.arrayBuffer())),
    fetch(`${E2E_BASE_URL}/api/webhooks/telegram/${missing}`, { method: "POST", body: "{}" }).then((response) => response.arrayBuffer()),
  ]);
  console.log(E2E_READY_LINE);
}

await warmUp();
