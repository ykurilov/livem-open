// Откат на прежнюю версию (SDK 0.25): идущим чатам — колонки напоминаний
// и дня старой версии по тому, что сделал сценарий. Запускать после остановки нового работника, до старта старого образа.
// По умолчанию — только посмотреть, что изменится. Записать — `--apply`. Повторный запуск ничего не меняет.
// В образе: `node dist/rollback-flows.js [--apply]`; локально: `pnpm flows:rollback [--apply]`.
import { formatRollbackReport, rollbackRunningChats } from "@/modules/flows/rollback";
import { openScriptFlow } from "@/modules/flows/script-flow";
import { systemClock } from "@/modules/platform/clock";
import { connectDatabase } from "@/modules/platform/db";
import { requireEnv } from "@/modules/platform/env";

const apply = process.argv.includes("--apply");
const databaseUrl = requireEnv("DATABASE_URL");
const connection = connectDatabase(databaseUrl, { poolSize: 2 });
const scripted = await openScriptFlow(connection, databaseUrl);
try {
  const report = await rollbackRunningChats({ db: connection.db, pool: connection.pool, flow: scripted.flow, clock: systemClock, apply });
  console.log(formatRollbackReport(report, { apply }));
} catch (error) {
  process.stderr.write(`Сбой: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await scripted.close();
  await connection.close();
}
