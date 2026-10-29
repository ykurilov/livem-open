// Прогон eval: сценарии в несколько потоков, каждый — `repeats` раз, проверки кодом и папка для судьи.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { checkScenario } from "./checks";
import { runWithConcurrency } from "./pool";
import { runFolderName, writeRunSummary, writeScenarioReport, type RunSummary } from "./report";
import type { Scenario } from "./scenario";
import type { ScenarioOutcome, ScenarioRun } from "./types";
import { verdictOf } from "./verdict";

const VERDICT_LOG = { pass: "успех", fail: "провал", persona: "сбой персонажа", stand: "сломан стенд" } as const;

export interface RunEvalOptions {
  scenarios: Scenario[];
  /** Сколько раз прогнать каждый сценарий; у каждого повтора своя база и своя папка. По умолчанию 1. */
  repeats?: number;
  concurrency: number;
  outputRoot: string;
  now?: Date;
  runScenario(scenario: Scenario, repeat: number): Promise<ScenarioRun>;
  log(line: string): void;
}

export async function runEval(options: RunEvalOptions): Promise<{ runDir: string; summary: RunSummary }> {
  const started = options.now ?? new Date();
  const runDir = path.join(options.outputRoot, runFolderName(started));
  await mkdir(runDir, { recursive: true });
  const startedMs = Date.now();

  const repeats = options.repeats ?? 1;
  // Сначала первые повторы всех сценариев: при пределе расхода каждый сценарий успеет пройти хоть раз
  const units = Array.from({ length: repeats }, (_, index) => options.scenarios.map((scenario) => ({ scenario, repeat: index + 1 }))).flat();
  const settled = await runWithConcurrency(units, options.concurrency, async ({ scenario, repeat }): Promise<ScenarioOutcome> => {
    const label = repeats > 1 ? `${scenario.id} #${repeat}` : scenario.id;
    options.log(`▶ ${label}`);
    const run = await options.runScenario(scenario, repeat);
    const outcome: ScenarioOutcome = { run, checks: checkScenario(run), ...(repeats > 1 && { repeat }) };
    await writeScenarioReport(runDir, outcome);
    const failed = outcome.checks.filter((check) => check.status === "fail").length;
    options.log(`■ ${label}: ${VERDICT_LOG[verdictOf(outcome.checks)]}, ${Math.round(run.durationMs / 1000)} с, проверок не пройдено: ${failed}`);
    return outcome;
  });

  const summary: RunSummary = {
    outcomes: settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    crashed: settled.flatMap((result, index) => {
      if (result.status !== "rejected") return [];
      const { scenario, repeat } = units[index]!;
      return [{ id: scenario.id, kind: scenario.kind, ...(scenario.set && { set: scenario.set }), ...(repeats > 1 && { repeat }), error: result.reason instanceof Error ? result.reason.message : String(result.reason) }];
    }),
    repeats,
    startedAt: started.toISOString(),
    durationMs: Date.now() - startedMs,
  };
  await writeRunSummary(runDir, summary);
  return { runDir, summary };
}
