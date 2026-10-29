// Готовность работника для Docker: отметка после миграций и обработчиков, проверка контейнера. Выкладка — deploy-release.test.ts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKER_READY_MAX_AGE_MS, clearWorkerReady, startWorkerReadiness } from "./readiness";

const ROOT = process.cwd();
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "livem-ready-"));
  file = join(dir, "worker-ready.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Проверка контейнера работника — та же команда, что в healthcheck работника в docker-compose. */
const containerCheck = () => spawnSync("node", ["deploy/worker-ready.cjs"], { cwd: ROOT, env: { ...process.env, WORKER_READY_FILE: file } }).status;

describe("готовность работника для проверки контейнера", () => {
  it("нет отметки (работник ещё мигрирует или упал при старте) — не готов", () => {
    expect(containerCheck()).toBe(1);
  });

  it("очередь отвечает — отметка пишется сразу, контейнер готов; остановка снимает отметку", async () => {
    const readiness = await startWorkerReadiness({ file, ping: async () => true });
    expect(containerCheck()).toBe(0);
    await readiness.stop();
    expect(containerCheck()).toBe(1);
  });

  it("очередь не отвечает — отметки нет, контейнер не готов", async () => {
    const readiness = await startWorkerReadiness({ file, ping: async () => false });
    try {
      expect(containerCheck()).toBe(1);
    } finally {
      await readiness.stop();
    }
  });

  it("отметка устарела (работник завис или очередь перестала отвечать) — не готов", async () => {
    const readiness = await startWorkerReadiness({ file, ping: async () => true, now: () => Date.now() - WORKER_READY_MAX_AGE_MS - 1_000 });
    try {
      expect(containerCheck()).toBe(1);
    } finally {
      await readiness.stop();
    }
  });

  it("отметка прошлого запуска того же контейнера стирается при новом старте", async () => {
    // Прошлый запуск упал, не успев убрать свежую отметку; контейнер перезапущен с той же файловой системой
    writeFileSync(file, JSON.stringify({ beatAt: Date.now() }));
    expect(containerCheck()).toBe(0);
    await clearWorkerReady(file);
    expect(containerCheck()).toBe(1);
  });
});
