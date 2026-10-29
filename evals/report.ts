// Раскладка папки прогона: по сценарию — переписки, настройки и проверки (md + json), в корне — сводка.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeAgentInstructions } from "./agent-instructions";
import { outcomeOf } from "./checks";
import { renderChecks, renderClient, renderConstructor, renderLeadMagnet, STATUS_MARK, statsOf } from "./render-markdown";
import type { ScenarioOutcome } from "./types";
import { tallyRepeats, verdictOf, type CrashedRepeat, type KindTally, type RunVerdict, type ScenarioTally, type SetTally } from "./verdict";

const pad = (value: number) => String(value).padStart(2, "0");

/** Имя папки прогона по местному времени: `2026-10-05_14-03-07`. */
export function runFolderName(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}_${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
}

const toJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Папка повтора относительно папки прогона: `<сценарий>/r<k>`; без повторов — `<сценарий>`. */
export const repeatDir = (id: string, repeat?: number) => (repeat ? `${id}/r${repeat}` : id);

export async function writeScenarioReport(runDir: string, { run, checks, repeat }: ScenarioOutcome): Promise<string> {
  const dir = path.join(runDir, repeatDir(run.scenario.id, repeat));
  await mkdir(dir, { recursive: true });
  const stats = statsOf(run);
  const files: Record<string, string> = {
    "constructor.md": renderConstructor(run),
    "constructor.json": toJson({ scenario: run.scenario, ...run.building }),
    "lead-magnet.md": renderLeadMagnet(run.settings, run.publishError),
    "lead-magnet.json": toJson(run.settings),
    "checks.md": renderChecks(run, checks, stats),
    "checks.json": toJson({
      scenario: run.scenario.id,
      kind: run.scenario.kind,
      startedAt: run.startedAt,
      checks,
      stats,
      agentLogErrors: run.agentLogErrors,
      ...(run.agentLogRecovered && { agentLogRecovered: run.agentLogRecovered }),
      runnerErrors: run.runnerErrors,
      ...(run.personaRoute && { personaRoute: run.personaRoute }),
      publishError: run.publishError,
      privacyPolicyUrl: run.privacyPolicyUrl,
    }),
  };
  for (const client of run.clients) {
    files[`client-${client.index}.md`] = renderClient(run, client);
    files[`client-${client.index}.json`] = toJson({ ...client, card: run.scenario.clients[client.index - 1]?.card });
  }
  await Promise.all([...Object.entries(files).map(([name, text]) => writeFile(path.join(dir, name), text)), writeAgentInstructions(dir, run.settings)]);
  return dir;
}

export interface RunSummary {
  outcomes: ScenarioOutcome[];
  /** Повторы, которые упали целиком, не дав результата. */
  crashed: CrashedRepeat[];
  /** Сколько раз прогнан каждый сценарий; нет — один. */
  repeats?: number;
  startedAt: string;
  durationMs: number;
}

const VERDICT_MARK: Record<RunVerdict, string> = { pass: STATUS_MARK.pass, fail: STATUS_MARK.fail, persona: STATUS_MARK.persona_broke, stand: STATUS_MARK.stand_broke };
const passAllMark = (passAll: boolean | null) => (passAll === null ? "?" : passAll ? "✅" : "❌");
const ratio = (part: number, whole: number) => `${part}/${whole}`;

function repeatsSection(tally: { scenarios: ScenarioTally[]; kinds: KindTally[]; sets: SetTally[] }, repeats: number): string[] {
  const groupRow = (name: string, group: Omit<KindTally, "kind">) =>
    `| ${name} | ${group.scenarios} | ${ratio(group.passed, group.counted)} | ${ratio(group.passAll, group.passAllKnown)} | ${group.persona} | ${group.stand} |`;
  return [
    "## По сценариям",
    "",
    `k/n — успешных из засчитанных повторов. pass^${repeats} — сценарий прошёл все повторы (${repeats}): ✅ да, ❌ нет, ? засчитано меньше ${repeats} без провала.`,
    `${STATUS_MARK.persona_broke} — персонаж вышел из роли, ${STATUS_MARK.stand_broke} — сломан стенд: такие повторы в n не идут.`,
    "",
    `| Сценарий | Вид | Набор | k/n | pass^${repeats} | ${STATUS_MARK.persona_broke} | ${STATUS_MARK.stand_broke} | Повторы |`,
    "|---|---|---|---|---|---|---|---|",
    ...tally.scenarios.map(
      (item) =>
        `| ${item.id} | ${item.kind} | ${item.set} | ${ratio(item.passed, item.counted)} | ${passAllMark(item.passAll)} | ${item.persona} | ${item.stand} | ${item.verdicts.map(({ repeat, verdict }) => `[r${repeat}](${repeatDir(item.id, repeat)}/checks.md) ${VERDICT_MARK[verdict]}`).join(" ")} |`,
    ),
    "",
    "## По уровням",
    "",
    `| Уровень | Сценариев | k/n | pass^${repeats} | ${STATUS_MARK.persona_broke} | ${STATUS_MARK.stand_broke} |`,
    "|---|---|---|---|---|---|",
    ...tally.kinds.map((kind) => groupRow(kind.kind, kind)),
    "",
    "## По наборам",
    "",
    `| Набор | Сценариев | k/n | pass^${repeats} | ${STATUS_MARK.persona_broke} | ${STATUS_MARK.stand_broke} |`,
    "|---|---|---|---|---|---|",
    ...tally.sets.map((set) => groupRow(set.set, set)),
    "",
    "## Все прогоны",
    "",
  ];
}

export async function writeRunSummary(runDir: string, summary: RunSummary): Promise<void> {
  const repeats = summary.repeats ?? 1;
  const tally = tallyRepeats(summary.outcomes, summary.crashed, repeats);
  const rows = summary.outcomes.map(({ run, checks, repeat }) => {
    const stats = statsOf(run);
    const failed = checks.filter((check) => check.status === "fail");
    return {
      id: run.scenario.id,
      ...(repeat && { repeat }),
      dir: repeatDir(run.scenario.id, repeat),
      verdict: verdictOf(checks),
      kind: run.scenario.kind,
      set: run.scenario.set,
      title: run.scenario.title,
      passed: checks.filter((check) => check.status === "pass").length,
      failed: failed.length,
      failedChecks: failed.map((check) => `${check.id} (${check.subject})`),
      finished: run.clients.map((client) => client.endedBy),
      outcomes: run.clients.map(outcomeOf),
      durationMs: stats.durationMs,
      costUsd: stats.costUsd,
      ...(stats.bySource && {
        judgeUsd: stats.bySource.judge.costUsd,
        firstMessageUsd: stats.bySource.firstMessage.costUsd,
        answerCorrectionUsd: stats.bySource.answerCorrection.costUsd,
      }),
    };
  });
  const parts = (row: (typeof rows)[number]) =>
    row.judgeUsd === undefined ? "—" : [row.judgeUsd, row.firstMessageUsd!, row.answerCorrectionUsd!].map((usd) => usd.toFixed(4)).join(" / ");
  const totalCostUsd = rows.reduce((sum, row) => sum + row.costUsd, 0);
  await writeFile(
    path.join(runDir, "summary.json"),
    toJson({
      startedAt: summary.startedAt,
      durationMs: summary.durationMs,
      totalCostUsd,
      repeats,
      byScenario: tally.scenarios,
      byKind: tally.kinds,
      bySet: tally.sets,
      scenarios: [...rows, ...summary.crashed.map((crash) => ({ ...crash, ...(crash.repeat && { dir: repeatDir(crash.id, crash.repeat) }), crashed: true }))],
    }),
  );
  const markdown = [
    "# Сводка прогона eval",
    "",
    `Начало: ${summary.startedAt}. Длительность: ${(summary.durationMs / 60_000).toFixed(1)} мин. Стоимость: $${totalCostUsd.toFixed(3)}. Повторов: ${repeats}.`,
    "",
    ...repeatsSection(tally, repeats),
    "| Сценарий | Вид | Итог | ✅ | ❌ | Клиенты | Время | $ | Судья / касания / переписка, $ | Провалы проверок |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| [${row.dir}](${row.dir}/checks.md) | ${row.kind} | ${VERDICT_MARK[row.verdict]} | ${row.passed} | ${row.failed} | ${row.finished.map((end, index) => (row.outcomes[index] ? `${end} (${row.outcomes[index]})` : end)).join(", ")} | ${(row.durationMs / 1000).toFixed(0)} с | ${row.costUsd.toFixed(3)} | ${parts(row)} | ${row.failedChecks.join("<br>")} |`,
    ),
    ...summary.crashed.map((crash) => `| ${repeatDir(crash.id, crash.repeat)} | ${crash.kind ?? "—"} | ${VERDICT_MARK.stand} | — | — | упал | — | — | — | ${crash.error.replace(/\|/g, "\\|")} |`),
    "",
    "Оценку смысла делает судья по `evals/judge.md`.",
    "",
  ].join("\n");
  await writeFile(path.join(runDir, "summary.md"), markdown);
}
