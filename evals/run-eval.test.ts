// Повторы: каждый повтор сценария — свой запуск со своей базой и своей папкой; сводка — k/N и pass^N.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenarioRun, recheckRun } from "./recheck";
import { runEval } from "./run-eval";
import { scenarioRun } from "./test-fixtures";

const base = scenarioRun();
const scenario = (id: string, kind: "normal" | "provocateur", set: "growth" | "regression" | "holdout" = "growth") => ({ ...base.scenario, id, kind, set });

describe("runEval с повторами", () => {
  it("каждый повтор — отдельный запуск и папка <сценарий>/r<k>; сначала первые повторы всех сценариев", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "eval-repeats-"));
    const started: string[] = [];
    const { runDir, summary } = await runEval({
      scenarios: [scenario("normal-yoga", "normal"), scenario("provocateur-x", "provocateur")],
      repeats: 2,
      concurrency: 1,
      outputRoot,
      now: new Date(2026, 9, 25, 12, 0, 0),
      log: () => {},
      runScenario: async (item, repeat) => {
        started.push(`${item.id}#${repeat}`);
        if (item.id === "provocateur-x" && repeat === 2) throw new Error("Не запущен: расход дошёл до предела");
        return scenarioRun({ scenario: item });
      },
    });

    expect(started).toEqual(["normal-yoga#1", "provocateur-x#1", "normal-yoga#2", "provocateur-x#2"]);
    expect((await readdir(path.join(runDir, "normal-yoga"))).sort()).toEqual(["r1", "r2"]);
    expect((await readdir(path.join(runDir, "normal-yoga", "r2"))).length).toBe(11);
    expect(summary.crashed).toEqual([{ id: "provocateur-x", kind: "provocateur", set: "growth", repeat: 2, error: "Не запущен: расход дошёл до предела" }]);

    const json = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8"));
    expect(json.repeats).toBe(2);
    expect(json.byScenario).toEqual([
      expect.objectContaining({ id: "normal-yoga", passed: 2, counted: 2, passAll: true }),
      expect.objectContaining({ id: "provocateur-x", passed: 1, counted: 1, stand: 1, passAll: null }),
    ]);
    const md = await readFile(path.join(runDir, "summary.md"), "utf8");
    expect(md).toContain("Повторов: 2");
    expect(md).toContain("| normal-yoga | normal | growth | 2/2 | ✅ |");
    expect(md).toContain("## По уровням");
    expect(md).toContain("## По наборам");
    expect(md).toContain("| growth | 2 | 3/3 |");
    expect(md).toContain("[r2](normal-yoga/r2/checks.md)");

    // Пересчёт находит повторы по их папкам
    expect((await loadScenarioRun(path.join(runDir, "normal-yoga", "r1"))).scenario.id).toBe("normal-yoga");
    const rechecked = await recheckRun(runDir);
    expect(rechecked.repeats).toBe(2);
    expect(rechecked.outcomes.map((outcome) => `${outcome.run.scenario.id}#${outcome.repeat}`).sort()).toEqual(["normal-yoga#1", "normal-yoga#2", "provocateur-x#1"]);
    expect(rechecked.crashed).toHaveLength(1);
    await rm(outputRoot, { recursive: true, force: true });
  });

  it("набор виден у каждого сценария, итоги по наборам — в summary.json и summary.md", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "eval-sets-"));
    const { runDir } = await runEval({
      scenarios: [scenario("normal-yoga", "normal", "regression"), scenario("provocateur-x", "provocateur", "growth")],
      repeats: 1,
      concurrency: 1,
      outputRoot,
      log: () => {},
      runScenario: async (item) => scenarioRun({ scenario: item }),
    });
    const json = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8"));
    expect(json.byScenario.map((item: { id: string; set: string }) => `${item.id}:${item.set}`)).toEqual(["normal-yoga:regression", "provocateur-x:growth"]);
    expect(json.bySet.map((item: { set: string }) => item.set)).toEqual(["growth", "regression"]);
    const md = await readFile(path.join(runDir, "summary.md"), "utf8");
    expect(md).toContain("| normal-yoga | normal | regression | 1/1 | ✅ |");
    expect(md).toContain("| regression | 1 | 1/1 | 1/1 | 0 | 0 |");
    await rm(outputRoot, { recursive: true, force: true });
  });

  it("один повтор — папка сценария как раньше", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "eval-repeats-"));
    const { runDir } = await runEval({
      scenarios: [scenario("normal-yoga", "normal")],
      repeats: 1,
      concurrency: 1,
      outputRoot,
      log: () => {},
      runScenario: async (item) => scenarioRun({ scenario: item }),
    });
    expect(await readdir(path.join(runDir, "normal-yoga"))).toContain("checks.md");
    await rm(outputRoot, { recursive: true, force: true });
  });
});
