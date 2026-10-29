// Точка входа работника: `pnpm worker:dev` / `node dist/worker.js`.
// Работник держит очередь на PostgreSQL; обработчики задач каждого этапа регистрируются в `registerJobHandlers`.
import { reportSettingsTranslation, translateSettingsToFlow } from "@/modules/flows";
import { connectDatabase, migrateDatabase } from "@/modules/platform/db";
import { requireEnv } from "@/modules/platform/env";
import { createQueue } from "@/modules/platform/queue";
import { registerJobHandlers } from "./job-handlers";
import { clearWorkerReady, startWorkerReadiness, workerReadyFile } from "./readiness";

const databaseUrl = requireEnv("DATABASE_URL");
const readyFile = workerReadyFile();
// Контейнер готов, только когда этот запуск дошёл до конца старта: отметка прошлого запуска стирается сразу
await clearWorkerReady(readyFile);
const connection = connectDatabase(databaseUrl);

// Работник стартует вместе с приложением и сам приводит схему в порядок: отдельного шага деплоя не нужно
await migrateDatabase(connection);
// Настройкам лидмагнитов без сценария — сценарий из этапов и программы
reportSettingsTranslation(await translateSettingsToFlow(connection.db));

const queue = createQueue({ connectionString: databaseUrl, role: "worker" });
await queue.start();
const handlers = await registerJobHandlers({ queue, connection });
// Миграции применены, обработчики зарегистрированы: с этого момента Docker и выкладка считают работника готовым
const readiness = await startWorkerReadiness({ file: readyFile, ping: () => queue.ping() });
console.log("Работник запущен");

/** Сколько ждать идущие ответы консультанта при остановке; `stop_grace_period` работника в деплое — с запасом больше. */
const WAIT_FOR_ANSWERS_MS = 20_000;

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`Получен ${signal}, останавливаю работника`);
  try {
    await readiness.stop();
    // Очередь перестаёт брать задачи и ждёт идущие; ходы консультанта дорабатывают, не успевшие — «Стоп» и повтор
    await Promise.all([queue.stop(), handlers.stopFlows(), handlers.flush({ waitForAnswersMs: WAIT_FOR_ANSWERS_MS })]);
    await connection.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
