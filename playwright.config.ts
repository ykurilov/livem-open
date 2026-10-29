import { defineConfig } from "@playwright/test";
import { E2E_BASE_URL, E2E_READY_LINE } from "./tests/e2e/e2e-env";

// Полный браузерный прогон — не дольше 5 минут
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  timeout: 60_000,
  globalTimeout: 5 * 60_000,
  reporter: "list",
  use: { baseURL: E2E_BASE_URL, locale: "ru-RU" },
  webServer: {
    command: "pnpm exec tsx tests/e2e/start-server.ts",
    wait: { stdout: new RegExp(E2E_READY_LINE) },
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
