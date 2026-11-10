import { defineConfig } from "@playwright/test";
import { E2E_BASE_URL, E2E_READY_LINE } from "./tests/e2e/e2e-env";

// Эти файлы меняют общее состояние (бюджет, расход, адрес политики): остальные тесты в это время видят чужие тревоги и снимки расходятся.
// Поэтому они идут отдельной группой после всех (друг с другом они рассчитаны на соседство)
const SHARED_STATE_SPECS = /(settings|publish-and-talk)\.spec\.ts$/;
// Пояс у тестовых чатов «Проверки» общий на кабинет, и каждый ход пишет в него пояс браузера. Дни «Проверки» тест
// считает в поясе, где сейчас полдень, а соседи по прогону — в поясе машины: их ход посреди теста сдвигает дни
const PREVIEW_DAY_SPECS = /preview-day\.spec\.ts$/;

// Полный браузерный прогон — не дольше 5 минут
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  timeout: 60_000,
  // Dev-сервер собирает страницы по требованию: ожидание условия на загруженной машине бывает дольше пяти секунд
  expect: { timeout: 15_000 },
  workers: 4,
  // Предел полного прогона — 5 минут; на занятой машине его можно поднять, чтобы получить честный результат, а не «не запускались»
  globalTimeout: Number(process.env.E2E_GLOBAL_TIMEOUT_MIN ?? 5) * 60_000,
  reporter: "list",
  use: { baseURL: E2E_BASE_URL, locale: "ru-RU" },
  // Имена эталонов без названия группы: файлы снимков остаются прежними
  snapshotPathTemplate: "{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}",
  projects: [
    { name: "main", testIgnore: [SHARED_STATE_SPECS, PREVIEW_DAY_SPECS] },
    { name: "shared-state", testMatch: SHARED_STATE_SPECS, dependencies: ["main"] },
    { name: "preview-day", testMatch: PREVIEW_DAY_SPECS, dependencies: ["main"] },
  ],
  webServer: {
    command: "pnpm exec tsx tests/e2e/start-server.ts",
    wait: { stdout: new RegExp(E2E_READY_LINE) },
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
