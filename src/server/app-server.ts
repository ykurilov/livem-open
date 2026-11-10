// Сервер приложения: Next.js и WebSocket голосового ввода на одном порту. Route handlers Next.js WebSocket не держат,
// поэтому соединение голоса (`/api/voice/stream`) поднимается здесь, а остальное отдаётся Next.js.
// Разработка: `tsx src/server/app-server.ts --dev`; в образе — `node dist/app-server.js` в папке standalone-сборки.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import next from "next";
import { createVoiceUpgrade } from "@ykurilov/agent-chat-voice/node";

const VOICE_STREAM_PATH = "/api/voice/stream";
/** Столько ждём идущие запросы при остановке; Docker даёт веб-контейнеру 10 с. */
const SHUTDOWN_GRACE_MS = 8_000;

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT) || 3000;
// Как у `next dev`: при разработке слушаем все адреса машины; в образе адрес задаёт `HOSTNAME`, как у standalone-сборки
const hostname = dev ? "localhost" : process.env.HOSTNAME || "0.0.0.0";
const listenHost = dev ? undefined : hostname;
const dir = process.cwd();

if (!dev) {
  (process.env as Record<string, string>).NODE_ENV = "production";
  // Как `server.js` standalone-сборки: настройки берутся из сборки, `next.config.mjs` в образе нет
  const built = JSON.parse(readFileSync(path.join(dir, ".next", "required-server-files.json"), "utf8")) as { config: unknown };
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(built.config);
}

// Next.js вешает свой обработчик `upgrade` на `httpServer`. Сервер, который не слушает порт, держит его в стороне:
// иначе маршрут, ловящий любой адрес, закрыл бы соединение голоса. Свои подъёмы (горячая перезагрузка) Next.js
// получает через `emit` ниже.
const nextUpgrades = createServer();
const app = next({ dev, dir, hostname, port, httpServer: nextUpgrades, ...(dev && { webpack: true }) });
const handle = app.getRequestHandler();
await app.prepare();
// Код приложения — только после подготовки Next.js: модули входа читают его хранилище запроса (AsyncLocalStorage)
const { createAppVoiceRelay } = await import("../modules/voice/register");
const voiceRelay = await createAppVoiceRelay();

const voiceUpgrade = createVoiceUpgrade({ path: VOICE_STREAM_PATH, relay: () => voiceRelay });
const server = createServer((request, response) => void handle(request, response));
server.on("upgrade", (request, socket, head) => {
  if (!voiceUpgrade(request, socket, head)) nextUpgrades.emit("upgrade", request, socket, head);
});
const keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT);
if (Number.isFinite(keepAliveTimeout) && keepAliveTimeout >= 0) server.keepAliveTimeout = keepAliveTimeout;

server.listen(port, listenHost, () => console.log(`> Сервер готов: http://${hostname}:${port}${dev ? " (разработка)" : ""}`));

function shutdown(): void {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
