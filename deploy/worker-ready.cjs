// Проверка готовности контейнера работника (healthcheck в docker-compose.yml): отметка `src/worker/readiness.ts` есть и свежая.
// Код выхода 0 — готов, 1 — нет. Без зависимостей: запускается в образе отдельно от бандла работника.
const { readFileSync } = require("node:fs");

const MAX_AGE_MS = 60_000;
const file = (process.env.WORKER_READY_FILE || "").trim() || "/tmp/livem-worker-ready.json";

try {
  const { beatAt } = JSON.parse(readFileSync(file, "utf8"));
  const age = Date.now() - beatAt;
  process.exit(Number.isFinite(age) && age >= 0 && age < MAX_AGE_MS ? 0 : 1);
} catch {
  process.exit(1);
}
