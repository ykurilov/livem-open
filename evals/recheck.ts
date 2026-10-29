// Пересчёт проверок кодом по готовой папке прогона: модели не вызываются, переписки берутся из файлов.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { checkScenario } from "./checks";
import { repeatDir, writeRunSummary, writeScenarioReport, type RunSummary } from "./report";
import { EVAL_PRIVACY_POLICY_URL } from "./run-scenario";
import type { Scenario } from "./scenario";
import type { ClientRun, ScenarioRun } from "./types";

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8")) as T;

/** Папки до появления `publishError` в checks.json хранили его только в lead-magnet.md. */
async function legacyPublishError(dir: string): Promise<string | null> {
  const markdown = await readFile(path.join(dir, "lead-magnet.md"), "utf8");
  return markdown.match(/^⚠️ Не опубликован: (.*)$/m)?.[1] ?? null;
}

/** Результат сценария, собранный обратно из файлов его папки. */
export async function loadScenarioRun(dir: string): Promise<ScenarioRun> {
  const { scenario, ...building } = await readJson<ScenarioRun["building"] & { scenario: ScenarioRun["scenario"] }>(path.join(dir, "constructor.json"));
  const saved = await readJson<{
    startedAt: string;
    stats: { durationMs: number; agents: ScenarioRun["usage"]["agents"]; personas: ScenarioRun["usage"]["personas"] };
    agentLogErrors: string[];
    agentLogRecovered?: string[];
    runnerErrors: string[];
    personaRoute?: ScenarioRun["personaRoute"];
    publishError?: string | null;
    privacyPolicyUrl?: string;
  }>(path.join(dir, "checks.json"));
  const clientFiles = (await readdir(dir)).filter((name) => /^client-\d+\.json$/.test(name));
  const clients = await Promise.all(
    clientFiles.map(async (name) => {
      const { card: _card, ...client } = await readJson<ClientRun & { card?: string }>(path.join(dir, name));
      return client;
    }),
  );
  return {
    scenario,
    startedAt: saved.startedAt,
    durationMs: saved.stats.durationMs,
    building,
    settings: await readJson<ScenarioRun["settings"]>(path.join(dir, "lead-magnet.json")),
    publishError: saved.publishError !== undefined ? saved.publishError : await legacyPublishError(dir),
    privacyPolicyUrl: saved.privacyPolicyUrl ?? EVAL_PRIVACY_POLICY_URL,
    clients: clients.sort((a, b) => a.index - b.index),
    agentLogErrors: saved.agentLogErrors,
    ...(saved.agentLogRecovered && { agentLogRecovered: saved.agentLogRecovered }),
    runnerErrors: saved.runnerErrors,
    ...(saved.personaRoute && { personaRoute: saved.personaRoute }),
    usage: { agents: saved.stats.agents, personas: saved.stats.personas },
  };
}

/** Пересчитывает проверки всех сценариев папки и переписывает её файлы; время и стоимость прогона остаются прежними. */
export async function recheckRun(runDir: string): Promise<RunSummary> {
  const saved = await readJson<{
    startedAt: string;
    durationMs: number;
    repeats?: number;
    scenarios: Array<{ id: string; kind?: Scenario["kind"]; set?: Scenario["set"]; repeat?: number; crashed?: boolean; error?: string }>;
  }>(path.join(runDir, "summary.json"));
  const outcomes = [];
  for (const entry of saved.scenarios.filter((scenario) => !scenario.crashed)) {
    const run = await loadScenarioRun(path.join(runDir, repeatDir(entry.id, entry.repeat)));
    const outcome = { run, checks: checkScenario(run), ...(entry.repeat && { repeat: entry.repeat }) };
    await writeScenarioReport(runDir, outcome);
    outcomes.push(outcome);
  }
  const summary: RunSummary = {
    outcomes,
    crashed: saved.scenarios
      .filter((scenario) => scenario.crashed)
      .map((scenario) => ({ id: scenario.id, ...(scenario.kind && { kind: scenario.kind }), ...(scenario.set && { set: scenario.set }), ...(scenario.repeat && { repeat: scenario.repeat }), error: scenario.error ?? "" })),
    ...(saved.repeats && { repeats: saved.repeats }),
    startedAt: saved.startedAt,
    durationMs: saved.durationMs,
  };
  await writeRunSummary(runDir, summary);
  return summary;
}
