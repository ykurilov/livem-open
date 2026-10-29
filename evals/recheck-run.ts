// `pnpm eval:recheck evals/runs/<папка>`: пересчитать проверки кодом в готовой папке без нового прогона моделей.
import path from "node:path";
import { recheckRun } from "./recheck";

async function main(): Promise<void> {
  const runDir = process.argv[2];
  if (!runDir) throw new Error("Укажите папку прогона: pnpm eval:recheck evals/runs/<дата-время>");
  const summary = await recheckRun(path.resolve(runDir));
  for (const { run, checks } of summary.outcomes) {
    const failed = checks.filter((check) => check.status === "fail");
    console.log(`■ ${run.scenario.id}: проверок не пройдено: ${failed.length}${failed.length ? ` — ${failed.map((check) => `${check.id} (${check.subject})`).join(", ")}` : ""}`);
  }
  console.log(`Готово: ${path.resolve(runDir)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
