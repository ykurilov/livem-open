// Сервер для сквозных проверок: пустая база с миграциями, сервер приложения в режиме разработки, подставной Soniox и работник очереди с подставными моделью и мессенджером.
// Страницы собираются заранее: иначе первая сборка страницы в одном тесте перезагружает вкладку соседнего.
import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
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
import { startFakeSoniox } from "./fake-soniox";

const admin = new Pool({ connectionString: TEST_ADMIN_DATABASE_URL, max: 1 });
await admin.query(`drop database if exists "${E2E_DATABASE_NAME}" with (force)`);
await admin.query(`create database "${E2E_DATABASE_NAME}"`);
await admin.end();

const connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 1 });
await migrateDatabase(connection);
await connection.close();

// Виджет для сайтов — готовым файлом, как в образе
execFileSync("pnpm", ["widget:build"], { stdio: "inherit" });

// Собранные при прогреве страницы остаются в памяти до конца прогона (`onDemandEntries` в next.config.mjs)
const soniox = await startFakeSoniox();
const env = { ...process.env, ...e2eServerEnv(), E2E_KEEP_DEV_PAGES: "1", PORT: String(E2E_PORT), SONIOX_API_KEY: "e2e-fake", SONIOX_WEBSOCKET_URL: soniox.url };
const server = spawn("pnpm", ["exec", "tsx", "src/server/app-server.ts", "--dev"], { stdio: "inherit", env });
const worker = spawn("pnpm", ["exec", "tsx", "src/worker/index.ts"], { stdio: "inherit", env });
const stop = () => {
  server.kill("SIGTERM");
  worker.kill("SIGTERM");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.on("exit", (code) => {
  worker.kill("SIGTERM");
  soniox.close();
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
  const pages = ["/", "/bots", "/settings", "/people", "/people/sources", `/people/${missing}`, "/fields", "/videos", "/images", "/inbox", "/knowledge", "/no-such-page", "/mailings", "/mailings/new", `/mailings/${missing}`, `/lead-magnets/${missing}`, `/lead-magnets/${missing}/publish`, `/bots/${missing}`, "/api/preview/models", "/api/constructor/models", "/api/role-swap/models", "/api/images/missing", `/api/inbox/images/in/${missing}`, "/c/missing", "/c/missing/manifest.webmanifest", "/api/web-chat/messages", `/api/web-chat/images/${missing}`, "/docs/api", "/api/v1/chats/missing", "/api/v1/chats/missing/messages", `/api/v1/images/${missing}`];
  const posts = [`/api/webhooks/telegram/${missing}`, "/api/web-chat/session", "/api/web-chat/away", "/api/web-chat/push", "/api/v1/chats/missing/session", "/api/v1/chats/missing/messages"];
  // «/knowledge» и «/no-such-page» (своя страница «не найдено») тоже: иначе их первая сборка посреди прогона перезагружает вкладки соседних тестов
  // Страницы независимы: собираются одновременно
  await Promise.all([
    ...pages.map((path) => fetch(`${E2E_BASE_URL}${path}`, { headers }).then((response) => response.arrayBuffer())),
    ...posts.map((path) => fetch(`${E2E_BASE_URL}${path}`, { method: "POST", body: "{}" }).then((response) => response.arrayBuffer())),
    // Закрытый маршрут собирается только для вошедшего: без входа его отсекает proxy
    fetch(`${E2E_BASE_URL}/api/web-chat-owner/start-over`, { method: "POST", body: "{}", headers }).then((response) => response.arrayBuffer()),
  ]);
  // Своя страница ошибки сервера: её собирает только оборванный запрос к уже собранному адресу. Конец сборки снаружи
  // не виден, а страница маленькая: десяти секунд хватает, пока вкладок ещё нет
  await abortMidBody("/api/web-chat/session");
  await new Promise((resolve) => setTimeout(resolve, ERROR_PAGE_BUILD_MS));
  console.log(E2E_READY_LINE);
}

const ERROR_PAGE_BUILD_MS = 10_000;

/**
 * Запрос, оборванный посреди тела (`Error: aborted`): так браузер бросает запрос, когда тест закрывает вкладку. Сервер
 * отвечает на это своей страницей ошибки (`/_error`), и её первая сборка посреди прогона перезагружала вкладки соседних
 * тестов.
 */
function abortMidBody(path: string): Promise<void> {
  return new Promise((resolve) => {
    const request = httpRequest(`${E2E_BASE_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", "content-length": "1000" } });
    request.on("error", () => resolve());
    request.write("{");
    setTimeout(() => {
      request.destroy();
      resolve();
    }, 500);
  });
}

await warmUp();
