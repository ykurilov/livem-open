import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildConsultantInstruction } from "../src/modules/consultant/instruction";
import { readConstructorPrompt } from "../src/modules/constructor/endpoint";
import { buildProgramInstructionSection } from "../src/modules/program/instruction-section";
import { checkScenario } from "./checks";
import { runFolderName, writeRunSummary, writeScenarioReport } from "./report";
import { flowStart, programClient, programRun, said, scenarioRun, silent, transition } from "./test-fixtures";
import type { UsageTotals } from "./types";

const spent = (costUsd: number): UsageTotals => ({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningTokens: 0, costUsd });

describe("runFolderName", () => {
  it("дата и время без двоеточий, по местному времени", () => {
    expect(runFolderName(new Date(2026, 9, 5, 14, 3, 7))).toBe("2026-10-05_14-03-07");
  });
});

describe("writeScenarioReport", () => {
  it("кладёт markdown и json по каждой части сценария", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "eval-run-"));
    const run = scenarioRun();
    await writeScenarioReport(runDir, { run, checks: checkScenario(run) });

    const files = (await readdir(path.join(runDir, "normal-yoga"))).sort();
    expect(files).toEqual([
      "agent-instructions.md",
      "checks.json",
      "checks.md",
      "client-1.json",
      "client-1.md",
      "client-2.json",
      "client-2.md",
      "constructor.json",
      "constructor.md",
      "lead-magnet.json",
      "lead-magnet.md",
    ]);

    const constructorMd = await readFile(path.join(runDir, "normal-yoga", "constructor.md"), "utf8");
    expect(constructorMd).toContain("Хочу лидмагнит");
    expect(constructorMd).toContain("edit_lead_magnet");

    const clientMd = await readFile(path.join(runDir, "normal-yoga", "client-1.md"), "utf8");
    expect(clientMd).toContain("Да, подходит");
    expect(clientMd).toContain("finish_dialog");
    expect(clientMd).toContain("Исход: agreed — согласился");

    const lead = JSON.parse(await readFile(path.join(runDir, "normal-yoga", "lead-magnet.json"), "utf8"));
    expect(lead.instruction).toBe("Ты консультант по йоге.");
    const checks = JSON.parse(await readFile(path.join(runDir, "normal-yoga", "checks.json"), "utf8"));
    expect(checks.checks.length).toBeGreaterThan(5);
    expect(checks.stats.costUsd).toBeCloseTo(0.012);
  });
});

describe("правила агентов в папке повтора", () => {
  const instructionsOf = async (runDir: string) => readFile(path.join(runDir, "normal-yoga", "agent-instructions.md"), "utf8");

  it("общие правила консультанта по настройкам этого лидмагнита и инструкция конструктора — дословно", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "eval-run-"));
    const run = scenarioRun();
    await writeScenarioReport(runDir, { run, checks: checkScenario(run) });
    const text = await instructionsOf(runDir);
    expect(text).toContain(buildConsultantInstruction(run.settings!));
    expect(text).toContain(readConstructorPrompt());
  });

  it("у программы — с разделом программы", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "eval-run-"));
    const run = programRun([programClient([said("Хочу игру", 1, "12:01")])]);
    await writeScenarioReport(runDir, { run, checks: checkScenario(run) });
    expect(await instructionsOf(runDir)).toContain(buildProgramInstructionSection(run.settings!)!);
  });

  it("лидмагнит не собран — правил консультанта нет, так и написано", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "eval-run-"));
    const run = scenarioRun({ settings: null, clients: [] });
    await writeScenarioReport(runDir, { run, checks: checkScenario(run) });
    const text = await instructionsOf(runDir);
    expect(text).toContain("лидмагнит не собран");
    expect(text).toContain(readConstructorPrompt());
  });

  it("пересчёт проверок не переписывает правила, с которыми шёл прогон", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "eval-run-"));
    const run = scenarioRun();
    await writeScenarioReport(runDir, { run, checks: checkScenario(run) });
    await writeFile(path.join(runDir, "normal-yoga", "agent-instructions.md"), "правила того прогона");
    await writeScenarioReport(runDir, { run, checks: checkScenario(run) });
    expect(await instructionsOf(runDir)).toBe("правила того прогона");
  });
});

describe("writeRunSummary", () => {
  it("сводка: таблица по сценариям, итоги стоимости и времени", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "eval-run-"));
    const run = scenarioRun();
    const failed = scenarioRun({ scenario: { ...run.scenario, id: "hard-x" }, settings: null, clients: [] });
    await writeRunSummary(runDir, {
      outcomes: [
        { run, checks: checkScenario(run) },
        { run: failed, checks: checkScenario(failed) },
      ],
      crashed: [{ id: "provocateur-y", error: "база недоступна" }],
      startedAt: "2026-10-05T10:00:00.000Z",
      durationMs: 600_000,
    });
    const summary = await readFile(path.join(runDir, "summary.md"), "utf8");
    expect(summary).toContain("normal-yoga");
    expect(summary).toContain("hard-x");
    expect(summary).toContain("provocateur-y");
    expect(summary).toContain("база недоступна");
    expect(summary).toContain("consultant_finished (agreed)");
    const json = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8"));
    expect(json.totalCostUsd).toBeCloseTo(0.024);
    expect(json.scenarios).toHaveLength(3);
  });
});

describe("цена и путь по сценарию в отчёте", () => {
  it("в цифрах сценария и в сводке — судья, касания и переписка ответа отдельными строками", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "eval-run-"));
    const run = scenarioRun();
    run.usage.bySource = { judge: spent(0.0004), firstMessage: spent(0.0021), answerCorrection: spent(0.0003) };
    await writeScenarioReport(runDir, { run, checks: checkScenario(run) });
    const checksMd = await readFile(path.join(runDir, "normal-yoga", "checks.md"), "utf8");
    expect(checksMd).toContain("Судья переходов: $0.0004");
    expect(checksMd).toContain("Касания (агент пишет первым): $0.0021");
    expect(checksMd).toContain("Переписка ответа: $0.0003");
    const checksJson = JSON.parse(await readFile(path.join(runDir, "normal-yoga", "checks.json"), "utf8"));
    expect(checksJson.stats.bySource.judge.costUsd).toBeCloseTo(0.0004);

    await writeRunSummary(runDir, { outcomes: [{ run, checks: checkScenario(run) }], crashed: [], startedAt: "2026-10-05T10:00:00.000Z", durationMs: 60_000 });
    const summary = await readFile(path.join(runDir, "summary.md"), "utf8");
    expect(summary).toContain("Судья / касания / переписка, $");
    expect(summary).toContain("0.0004 / 0.0021 / 0.0003");
    const json = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8"));
    expect(json.scenarios[0]).toMatchObject({ judgeUsd: 0.0004, firstMessageUsd: 0.0021, answerCorrectionUsd: 0.0003 });
  });

  it("у клиента — путь по сценарию с причинами, расход разговора; у лидмагнита — ноды и «Дни и время»", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "eval-run-"));
    const client = programClient([said("Хочу игру", 1, "12:01"), silent("до завтра", 2, "09:00", [["outreach", 2, "09:00", "Доброе утро!"]])], {
      flow: { transitions: [flowStart(), transition({ decidedBy: "judge", day: 2, reason: "Загорелся и спросил про курс" })], endReason: "deadline" },
      usage: { answerUsd: 0.01, firstMessageUsd: 0.002, correctionUsd: 0, judgeUsd: 0.0001 },
    });
    const run = programRun([client]);
    await writeScenarioReport(runDir, { run, checks: checkScenario(run) });
    const clientMd = await readFile(path.join(runDir, "normal-yoga", "client-1.md"), "utf8");
    expect(clientMd).toContain("день 2 → «Продажа», судья: Загорелся и спросил про курс");
    expect(clientMd).toContain("Конец по сценарию: deadline");
    expect(clientMd).toContain("судья $0.0001");
    expect(clientMd).toContain("Бот (день 2, 09:00, пишет первым)");
    const leadMd = await readFile(path.join(runDir, "normal-yoga", "lead-magnet.md"), "utf8");
    expect(leadMd).toContain("### Продажа");
    expect(leadMd).toContain("метки: продажа");
    expect(leadMd).toContain("с дня 3 программы → «Продажа»");
    expect(leadMd).toContain("Дни и время: 3 дн., день с 09:00, ночь с 21:00");
  });
});
