// Перенос идущих чатов старой версии на сценарии.
// По умолчанию — только посмотреть: что и куда будет перенесено, по каждому прохождению. Записать — `--apply`.
// Людям ничего не уходит: перенос ставит только сроки, касания шлёт работник. Повторный запуск ничего не меняет.
// Там же отменяются старые задачи напоминаний (`reminder`) в очереди: их больше некому обработать.
// В образе: `node dist/adopt-running-chats.js [--apply]`; локально: `pnpm flows:adopt [--apply]`.
import { cancelLegacyReminderJobs, formatLegacyReminderReport, openJobsQueue } from "@/modules/flows/legacy-reminder-jobs";
import { adoptRunningChats, formatAdoptionReport } from "@/modules/flows/running-chats";
import { openScriptFlow } from "@/modules/flows/script-flow";
import { connectDatabase } from "@/modules/platform/db";
import { requireEnv } from "@/modules/platform/env";

const apply = process.argv.includes("--apply");
const databaseUrl = requireEnv("DATABASE_URL");
const connection = connectDatabase(databaseUrl, { poolSize: 2 });
const scripted = await openScriptFlow(connection, databaseUrl);
const jobs = await openJobsQueue(databaseUrl);
try {
  const report = await adoptRunningChats({ db: connection.db, pool: connection.pool, flow: scripted.flow, now: new Date(), apply });
  console.log(formatAdoptionReport(report, { apply }));
  console.log(formatLegacyReminderReport(await cancelLegacyReminderJobs(jobs.queue, { apply }), { apply }));
  if (report.some((item) => item.outcome === "failed")) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Сбой: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await jobs.close();
  await scripted.close();
  await connection.close();
}
