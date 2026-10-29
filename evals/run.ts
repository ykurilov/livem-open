// `pnpm eval [--set growth|regression|holdout] [--scenario <id>[,<id>…]] [--repeat 3] [--concurrency 4] [--max-cost 3]`: прогон сценариев на настоящих моделях приложения.
// Без `--set` идут «на рост» и «на поломки»; отложенные сценарии (`scenarios-holdout/`) — только с `--set holdout`.
// `--repeat N` — каждый сценарий N раз (своя база и папка у каждого повтора), перед выпуском — 5. `--max-cost` — на все повторы.
// Персонажи — на своей модели (persona-model.ts): `--persona-model`, `--persona-provider`, `--persona-temperature`,
// `--persona-reasoning` или переменные `EVAL_PERSONA_*`.
// Только локально: база eval на локальном PostgreSQL, мессенджер подделан. Ключи — из .env.local, в вывод не попадают.
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAppModels } from "@/modules/platform/app-models";
import { evalAdminUrl } from "./eval-database";
import { findPersonaEndpoint, openPersonaRoute, personaModelSettings } from "./persona-model";
import { runEval } from "./run-eval";
import { EVAL_PRIVACY_POLICY_URL, runScenario } from "./run-scenario";
import { loadScenarioSet, SCENARIO_SETS, type ScenarioSet } from "./scenario";
import type { ScenarioRun } from "./types";

const EVALS_DIR = path.join(process.cwd(), "evals");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string" },
      set: { type: "string" },
      repeat: { type: "string", default: "3" },
      concurrency: { type: "string", default: "4" },
      "max-cost": { type: "string", default: "3" },
      "persona-model": { type: "string" },
      "persona-provider": { type: "string" },
      "persona-temperature": { type: "string" },
      "persona-reasoning": { type: "string" },
    },
  });
  const concurrency = Number(values.concurrency);
  const maxCost = Number(values["max-cost"]);
  const repeats = Number(values.repeat);
  const set = SCENARIO_SETS.find((known) => known === values.set);
  if (values.set !== undefined && !set) throw new Error(`--set: ${SCENARIO_SETS.join(", ")}`);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeat: целое число от 1");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency: целое число от 1");
  if (!(maxCost > 0)) throw new Error("--max-cost: сумма в долларах больше нуля");

  if (process.env.STUB_MODEL) throw new Error("Задана STUB_MODEL: eval идёт на настоящих моделях. Уберите переменную.");
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("Нет DEEPSEEK_API_KEY: положите ключ в .env.local, как для приложения.");
  if (!process.env.OPENROUTER_API_KEY) throw new Error("Нет OPENROUTER_API_KEY: персонажи eval идут через OpenRouter. Положите ключ в .env.local.");
  evalAdminUrl();
  const personaSettings = personaModelSettings(
    { model: values["persona-model"], provider: values["persona-provider"], temperature: values["persona-temperature"], reasoning: values["persona-reasoning"] },
    process.env,
  );
  const personaEndpoint = await findPersonaEndpoint(personaSettings, { apiKey: process.env.OPENROUTER_API_KEY });

  const scenarios = await loadScenarioSet(EVALS_DIR, set, values.scenario);
  const models = await loadAppModels(process.env);
  const costOf = (run: ScenarioRun) => run.usage.agents.costUsd + run.usage.personas.costUsd;
  let spent = 0;

  console.log(`Набор: ${set ?? "growth + regression"}, сценариев: ${scenarios.length}, повторов: ${repeats}, одновременно: ${concurrency}, предел расхода на все повторы: $${maxCost}`);
  console.log(
    `Персонажи: ${personaSettings.model} у ${personaEndpoint.providerName} (${personaSettings.provider}, без запасных), температура ${personaSettings.temperature}, рассуждения ${personaEndpoint.reasoning ? personaSettings.reasoning : "нет"}`,
  );
  const { runDir, summary } = await runEval({
    scenarios,
    repeats,
    concurrency,
    outputRoot: path.join(EVALS_DIR, "runs"),
    log: (line) => console.log(line),
    runScenario: async (scenario) => {
      // Предел проверяется перед стартом: уже идущие сценарии доходят до конца
      if (spent >= maxCost) throw new Error(`Не запущен: расход $${spent.toFixed(2)} дошёл до предела $${maxCost}`);
      const run = await runScenario(scenario, {
        models,
        openPersonaRoute: () => openPersonaRoute(personaSettings, personaEndpoint, { catalog: models.catalog, env: process.env }),
        privacyPolicyUrl: EVAL_PRIVACY_POLICY_URL,
      });
      spent += costOf(run);
      return run;
    },
  });

  const total = summary.outcomes.reduce((sum, outcome) => sum + costOf(outcome.run), 0);
  console.log(`\nГотово за ${Math.round(summary.durationMs / 1000)} с, расход $${total.toFixed(3)}`);
  console.log(`Папка прогона: ${runDir}`);
  if (summary.crashed.length) console.log(`Упали: ${summary.crashed.map((item) => `${item.id} (${item.error})`).join("; ")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
