// Прогон eval на подставной модели: боевая проводка, лимиты реплик, остановка на finish_dialog, параллельность, папка.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppModels } from "@/modules/platform/app-models";
import { createAppCatalog, createStubModelCatalog, STUB_MODEL_CHOICE } from "@/modules/platform/models-catalog";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "@/modules/platform/scripted-model";
import { createTestDatabase } from "../tests/integration/db-helper";
import { isJudgeCall } from "../tests/integration/live-dialog-kit";
import { checkScenario } from "./checks";
import { CLIENT_LEAVE_TOOL, CLIENT_WAIT_TOMORROW_TOOL, EXPERT_FINISH_TOOL } from "./persona-prompts";
import { runEval } from "./run-eval";
import { runScenario } from "./run-scenario";
import { stubPersonaRoute } from "./test-fixtures";
import type { Scenario } from "./scenario";
import { SILENCE_TILL_END } from "./types";

const AGREEING = "РЕЖИМ: соглашается";
const STUBBORN = "РЕЖИМ: молчун";
const SILENT = "РЕЖИМ: молчит до завтра";
const SUMMARY_QUESTION = "Итог: пробное занятие. Подходит?";

function constructorReply(call: ScriptedCall): ScriptedReply {
  if (call.lastToolResult !== undefined) return { text: "Готово, всё настроил." };
  return {
    delayMs: 150,
    toolCalls: [
      {
        toolName: "edit_lead_magnet",
        input: {
          changes: [
            { op: "set", field: "instruction", value: "Ты консультант студии йоги." },
            { op: "set", field: "firstMessage", value: "Привет! Что беспокоит?" },
            { op: "set", field: "endCondition", value: "Человек согласился на пробное занятие" },
            { op: "set", field: "farewellMessage", value: "Спасибо! До встречи на коврике." },
          ],
        },
      },
    ],
  };
}

function expertReply(call: ScriptedCall): ScriptedReply {
  if (call.lastToolResult !== undefined) return {};
  if (call.lastUserText.includes("Готово")) return { text: "Спасибо, всё.", toolCalls: [{ toolName: EXPERT_FINISH_TOOL, input: { reason: "собрано" } }] };
  return { text: "Хочу лидмагнит для студии йоги." };
}

function consultantReply(call: ScriptedCall): ScriptedReply {
  if (call.lastToolResult !== undefined) return { text: "Жду вас на занятии." };
  if (call.lastUserText.toLowerCase().includes("да, подходит"))
    return { toolCalls: [{ toolName: "finish_dialog", input: { goal: "Спина", stuckAt: "Нет времени", chosenStep: "Пробное", outcome: "agreed" } }] };
  return { text: SUMMARY_QUESTION };
}

function clientReply(call: ScriptedCall): ScriptedReply {
  if (call.lastToolResult !== undefined) return {};
  // Молчун пишет раз в день — утром, прочитав, что бот прислал за ночь, — и снова молчит до завтра
  if (call.system.includes(SILENT))
    return call.lastUserText.startsWith("[Ты молчал до") ? { text: "Ну норм" } : { toolCalls: [{ toolName: CLIENT_WAIT_TOMORROW_TOOL, input: { reason: "занят" } }] };
  if (call.system.includes(AGREEING) && call.lastUserText.includes(SUMMARY_QUESTION)) return { text: "Да, подходит" };
  return { text: call.system.includes(STUBBORN) ? "Не знаю" : "Болит спина" };
}

function stubModels(): AppModels {
  const scripted = createScriptedModel((call) => {
    // Запасной судья сценария — та же подставная модель: условия словами не выполнены, переходы — по срокам нод
    if (isJudgeCall(call)) return { text: JSON.stringify({ met: [] }) };
    if (call.toolNames.includes("edit_lead_magnet")) return constructorReply(call);
    if (call.toolNames.includes(EXPERT_FINISH_TOOL)) return expertReply(call);
    if (call.toolNames.includes("finish_dialog")) return consultantReply(call);
    if (call.toolNames.includes(CLIENT_LEAVE_TOOL)) return clientReply(call);
    throw new Error(`Непонятный запрос: инструменты ${call.toolNames.join(", ")}`);
  });
  return {
    catalog: createStubModelCatalog(createAppCatalog({}), scripted.model),
    constructorChoice: STUB_MODEL_CHOICE,
    consultantChoice: () => STUB_MODEL_CHOICE,
    env: { STUB_MODEL_API_KEY: "test" },
  };
}

function scenario(id: string): Scenario {
  return {
    id,
    kind: "normal",
    title: `Йога ${id}`,
    expertReplies: 4,
    clientReplies: 3,
    expert: { card: "Анна, тренер по йоге.", goal: "Лидмагнит на пробное занятие." },
    clients: [
      { name: "Согласная Марина", card: `Марина. ${AGREEING}` },
      { name: "Молчун Олег", card: `Олег. ${STUBBORN}` },
    ],
  };
}

const POLICY = "https://eval.local/privacy";
const stubRun = (item: Scenario, extra: Partial<Parameters<typeof runScenario>[1]> = {}, models = stubModels()) =>
  runScenario(item, { models, openPersonaRoute: () => stubPersonaRoute(models), privacyPolicyUrl: POLICY, createDatabase: () => createTestDatabase(), judgeFallback: STUB_MODEL_CHOICE, ...extra });

describe("runScenario на подставной модели", () => {
  it("эксперт собирает лидмагнит, один клиент доходит до finish_dialog, другой упирается в лимит реплик", async () => {
    const run = await stubRun(scenario("yoga"));

    expect(run.runnerErrors).toEqual([]);
    expect(run.building.endedBy).toBe("expert_finished");
    expect(run.building.expertReplies).toBe(2);
    expect(run.building.turns[0]!.tools.map((tool) => tool.name)).toEqual(["edit_lead_magnet"]);
    expect(run.building.chat.length).toBeGreaterThanOrEqual(4);
    expect(run.settings?.firstMessage).toBe("Привет! Что беспокоит?");
    expect(run.publishError).toBeNull();

    const [agreeing, stubborn] = run.clients;
    expect(agreeing!.endedBy).toBe("consultant_finished");
    expect(agreeing!.turns[0]!.bot[0]).toContain(POLICY);
    const finishing = agreeing!.turns.at(-1)!;
    expect(finishing.finished).toBe(true);
    expect(finishing.textAfterFinish).toBe("Жду вас на занятии.");
    expect(finishing.bot.join("\n")).toContain("До встречи на коврике.");
    expect(agreeing!.passage?.status).toBe("completed");
    expect(agreeing!.passage?.summary?.chosenStep).toBe("Пробное");
    expect(agreeing!.turns.slice(1).every((turn) => turn.consultantMessages === 1)).toBe(true);

    expect(stubborn!.endedBy).toBe("reply_limit");
    expect(stubborn!.clientReplies).toBe(3);
    // После реплик молчун молчит, пока разговор не кончится сам; чем кончится — тест ниже
    expect(stubborn!.turns).toHaveLength(5);
    expect(stubborn!.turns.at(-1)!.silence).toBe(SILENCE_TILL_END);
    expect(stubborn!.flow?.transitions[0]).toMatchObject({ title: "Разговор", decidedBy: "start" });
    expect(stubborn!.usage).toBeDefined();
    expect(stubborn!.chat.some((message) => message.role === "assistant")).toBe(true);
    expect(agreeing!.turns.some((turn) => turn.silence === SILENCE_TILL_END)).toBe(false);

    expect(run.agentLogErrors).toEqual([]);
    expect(run.usage.agents.inputTokens).toBeGreaterThan(0);
    expect(run.usage.personas.inputTokens).toBeGreaterThan(0);
    expect(run.usage.bySource).toBeDefined();
  });

  // Касания уходят доставкой сценария через наших ботов; у молчуна их за 3 дня больше пяти подряд (SDK 0.53)
  it("молчун после разговора: касания через 15 мин и 1 ч, через 3 дня тишины — «не завершил»", async () => {
    const run = await stubRun(scenario("yoga-silent"));
    const stubborn = run.clients[1]!;
    const tail = stubborn.turns.at(-1)!;
    expect(tail.timeline?.filter((message) => message.kind === "outreach").length).toBeGreaterThan(1);
    expect(stubborn.passage?.status).toBe("not_completed");
    expect(stubborn.flow?.endReason).toBe("abandoned");
    expect(checkScenario(run).filter((check) => check.status === "fail" && /^(flow_|nudges_)/.test(check.id))).toEqual([]);
  }, 60_000);
});

describe("runScenario: программа на несколько дней на подставной модели", () => {
  async function runProgram() {
    const root = await mkdtemp(path.join(tmpdir(), "eval-program-"));
    await writeFile(
      path.join(root, "app.json"),
      JSON.stringify({
        name: "Первое приложение",
        instruction: "Ты помощник.",
        firstMessage: "Привет! Что соберём?",
        endCondition: "Сказал «да» интенсиву",
        farewellMessage: "До встречи!",
        stages: [{ name: "Идея", instruction: "Помоги выбрать", transitionCondition: "Выбрал" }],
      }),
    );
    const program: Scenario = {
      ...scenario("program"),
      kind: "program",
      days: 3,
      leadMagnet: { file: "app.json", overlay: { stages: [{ name: "Продажа", instruction: "Предложи интенсив", transitionCondition: "", startDay: 3, isSale: true }] } },
      clients: [{ name: "Молчун Игорь", card: `Игорь. ${SILENT}`, startsAt: "12:00" }],
    };
    try {
      return await stubRun(program, { projectRoot: root });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("лидмагнит из файла переведён в сценарий; молчун пишет раз в день, часы идут без ожидания до утра нового дня", async () => {
    const startedAt = Date.now();
    const run = await runProgram();

    expect(run.runnerErrors).toEqual([]);
    expect(run.agentLogErrors).toEqual([]);
    expect(run.building.endedBy).toBe("from_file");
    expect(run.settings?.flow.schedule?.lengthDays).toBe(3);
    const sale = run.settings?.flow.states.find((state) => state.title === "Продажа");
    expect(sale?.tags).toEqual(["продажа"]);
    const [silent] = run.clients;
    expect(silent!.error).toBeUndefined();
    // Молчание «до завтра» кончается в 9:00 дня сценария; молчун пишет минутой позже
    const replies = silent!.turns.filter((turn) => turn.client === "Ну норм").map((turn) => `${turn.sentAt?.day} ${turn.sentAt?.localTime}`);
    expect(replies.slice(0, 2)).toEqual(["2 09:01", "3 09:01"]);
    expect(silent!.flow?.transitions[0]).toMatchObject({ title: "Идея", decidedBy: "start", day: 1 });
    expect(silent!.flow?.transitions.every((step) => step.decidedBy === "start" || step.reason)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(30_000);

    const failed = checkScenario(run).filter((check) => check.status === "fail" && /^(program_|flow_)/.test(check.id));
    expect(failed).toEqual([]);
  }, 60_000);

  // Сообщения первым уходят доставкой сценария через наших ботов — срез S6. До него писать первым нельзя, а тогда SDK
  // на сроке касания снимает все сроки чата до следующего сообщения человека: «Продажа» по сроку ноды не включается
  it("бот пишет первым по расписанию, «Продажа» по сроку в день 3, утром дня 4 — «срок вышел»", async () => {
    const run = await runProgram();
    const [silent] = run.clients;
    // Срок в «Продажу» — событие дня программы program_day_3 (не «нода длится N дней»): ровно в день 3
    expect(silent!.flow?.transitions).toContainEqual(expect.objectContaining({ title: "Продажа", decidedBy: "timer", day: 3 }));
    expect(silent!.passage?.status).toBe("term_ended");
    expect(silent!.endedBy).toBe("program_ended");
    expect(silent!.flow?.endReason).toBe("deadline");
    const outreach = silent!.turns.flatMap((turn) => turn.timeline ?? []).filter((message) => message.kind === "outreach");
    expect(outreach.length).toBeGreaterThan(0);
    expect(outreach.filter((message) => message.localTime! >= "21:00" || message.localTime! < "09:00")).toEqual([]);
    expect(checkScenario(run).filter((check) => check.status === "fail" && /^(program_|flow_)/.test(check.id))).toEqual([]);
  }, 60_000);
});

describe("runEval на подставной модели", () => {
  it("сценарии идут не больше заданного числа одновременно, папка прогона полная", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "eval-runs-"));
    const models = stubModels();
    let running = 0;
    let peak = 0;
    const { runDir } = await runEval({
      scenarios: [scenario("a"), scenario("b"), scenario("c")],
      concurrency: 2,
      outputRoot,
      now: new Date(2026, 9, 5, 12, 0, 0),
      log: () => {},
      runScenario: async (item) => {
        running += 1;
        peak = Math.max(peak, running);
        try {
          return await runScenario(item, { models, openPersonaRoute: () => stubPersonaRoute(models), privacyPolicyUrl: POLICY, createDatabase: () => createTestDatabase(), judgeFallback: STUB_MODEL_CHOICE });
        } finally {
          running -= 1;
        }
      },
    });

    expect(peak).toBe(2);
    expect(path.basename(runDir)).toBe("2026-10-05_12-00-00");
    expect((await readdir(runDir)).sort()).toEqual(["a", "b", "c", "summary.json", "summary.md"]);
    expect((await readdir(path.join(runDir, "b"))).length).toBe(11);
    const checks = JSON.parse(await readFile(path.join(runDir, "a", "checks.json"), "utf8"));
    const finish = checks.checks.filter((check: { id: string }) => check.id === "finish_dialog");
    expect(finish.map((check: { status: string }) => check.status)).toEqual(["pass", "fail"]);
    await rm(outputRoot, { recursive: true, force: true });
  }, 60_000);
});
