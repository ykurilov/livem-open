import { rm, writeFile } from "node:fs/promises";

/**
 * Готовность работника для Docker (`deploy/worker-ready.cjs`): файл с моментом последней удачной проверки очереди.
 * Пишется только после миграций и регистрации обработчиков и обновляется, пока очередь отвечает. Формат `{ beatAt }`
 * (мс) и срок свежести — общие с проверкой контейнера.
 */
export const DEFAULT_WORKER_READY_FILE = "/tmp/livem-worker-ready.json";
/** Отметка старше — работник завис или очередь перестала отвечать. Как `MAX_AGE_MS` в `deploy/worker-ready.cjs`. */
export const WORKER_READY_MAX_AGE_MS = 60_000;
const HEARTBEAT_MS = 15_000;

export function workerReadyFile(env: Record<string, string | undefined> = process.env): string {
  return env.WORKER_READY_FILE?.trim() || DEFAULT_WORKER_READY_FILE;
}

/** Старт работника: отметка прошлого запуска того же контейнера (файлы переживают перезапуск) не должна выдать его за готовый. */
export async function clearWorkerReady(file: string): Promise<void> {
  await rm(file, { force: true });
}

export interface WorkerReadiness {
  /** Остановка работника: отметка снимается, контейнер больше не готов. */
  stop(): Promise<void>;
}

/** Работник поднялся: отметка сразу и затем раз в `HEARTBEAT_MS`, если очередь отвечает. */
export async function startWorkerReadiness(input: { file: string; ping: () => Promise<boolean>; now?: () => number }): Promise<WorkerReadiness> {
  const now = input.now ?? Date.now;
  let stopped = false;
  const beat = async () => {
    const alive = await input.ping().catch(() => false);
    if (alive && !stopped) await writeFile(input.file, JSON.stringify({ beatAt: now() }));
  };
  await beat();
  const timer = setInterval(() => {
    beat().catch((error: unknown) => console.error("Отметка готовности работника не записана:", error instanceof Error ? error.message : String(error)));
  }, HEARTBEAT_MS);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await clearWorkerReady(input.file);
    },
  };
}
