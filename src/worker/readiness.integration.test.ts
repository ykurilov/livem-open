// Настоящий процесс работника: готов только после миграций и регистрации обработчиков, остановка снимает готовность.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { e2eServerEnv } from "../../tests/e2e/e2e-env";
import { createTestDatabase, type TestDatabase } from "../../tests/integration/db-helper";

const ROOT = process.cwd();
let database: TestDatabase;
let dir: string;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
  dir = mkdtempSync(join(tmpdir(), "livem-worker-"));
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await database.drop();
});

function startWorker(databaseUrl: string, file: string): ChildProcess {
  return spawn(join(ROOT, "node_modules/.bin/tsx"), ["src/worker/index.ts"], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, ...e2eServerEnv(), DATABASE_URL: databaseUrl, WORKER_READY_FILE: file },
  });
}

const containerCheck = (file: string) => spawnSync("node", ["deploy/worker-ready.cjs"], { cwd: ROOT, env: { ...process.env, WORKER_READY_FILE: file } }).status;
const exited = (child: ChildProcess) => new Promise<number | null>((done) => (child.exitCode !== null ? done(child.exitCode) : child.once("exit", (code) => done(code))));

async function readyWithin(child: ChildProcess, file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && child.exitCode === null) {
    if (containerCheck(file) === 0) return true;
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

describe("готовность настоящего работника", () => {
  it("готов после миграций и обработчиков; SIGTERM снимает готовность", async () => {
    const file = join(dir, "ready-ok.json");
    const worker = startWorker(database.url, file);
    try {
      expect(await readyWithin(worker, file, 60_000)).toBe(true);
      // Отметка появилась уже после миграций приложения
      const { rows } = await database.pool.query("select 1 from information_schema.tables where table_schema = 'app' and table_name = 'outbound_messages'");
      expect(rows).toHaveLength(1);
    } finally {
      worker.kill("SIGTERM");
      await exited(worker);
    }
    expect(containerCheck(file)).toBe(1);
  }, 90_000);

  it("база недоступна при старте — работник падает, готовности нет", async () => {
    const file = join(dir, "ready-broken.json");
    const missing = new URL(database.url);
    missing.pathname = `${missing.pathname}_missing`;
    const worker = startWorker(missing.toString(), file);
    expect(await exited(worker)).not.toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(containerCheck(file)).toBe(1);
  }, 60_000);
});
