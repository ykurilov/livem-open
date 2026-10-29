// Пересчёт проверок по готовой папке прогона: модели не вызываются, файлы переписываются по новым правилам.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkScenario } from "./checks";
import { loadScenarioRun, recheckRun } from "./recheck";
import { writeRunSummary, writeScenarioReport } from "./report";
import { scenarioRun } from "./test-fixtures";

async function writtenRun() {
  const runDir = await mkdtemp(path.join(tmpdir(), "eval-recheck-"));
  const run = scenarioRun();
  const outcome = { run, checks: checkScenario(run) };
  await writeScenarioReport(runDir, outcome);
  await writeRunSummary(runDir, { outcomes: [outcome], crashed: [{ id: "hard-x", error: "база недоступна" }], startedAt: run.startedAt, durationMs: 600_000 });
  return { runDir, run };
}

describe("recheck", () => {
  it("собирает результат сценария обратно из его файлов", async () => {
    const { runDir, run } = await writtenRun();
    expect(await loadScenarioRun(path.join(runDir, "normal-yoga"))).toEqual(run);
  });

  it("переписывает проверки и сводку, сохраняя время, стоимость и упавшие сценарии", async () => {
    const { runDir } = await writtenRun();
    const checksFile = path.join(runDir, "normal-yoga", "checks.json");
    const stale = JSON.parse(await readFile(checksFile, "utf8"));
    await writeFile(checksFile, JSON.stringify({ ...stale, checks: [{ id: "old", title: "Старое", subject: "сценарий", status: "fail", details: "" }] }));

    const summary = await recheckRun(runDir);

    const fresh = JSON.parse(await readFile(checksFile, "utf8"));
    expect(fresh.checks.some((check: { id: string }) => check.id === "old")).toBe(false);
    expect(fresh.checks.find((check: { id: string; subject: string }) => check.id === "farewell")?.status).toBe("pass");
    expect(summary).toMatchObject({ durationMs: 600_000, crashed: [{ id: "hard-x", error: "база недоступна" }] });
    const summaryMd = await readFile(path.join(runDir, "summary.md"), "utf8");
    expect(summaryMd).toContain("Длительность: 10.0 мин");
    expect(summaryMd).toContain("hard-x");
  });
});
