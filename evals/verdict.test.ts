// Итог прогона и повторы: успех — ни одного ❌; сломанный стенд и сбой персонажа в знаменатель не идут.
import { describe, expect, it } from "vitest";
import { checkScenario } from "./checks";
import { clientRun, scenarioRun } from "./test-fixtures";
import type { CheckResult, ScenarioRun } from "./types";
import { standCheck, tallyRepeats, verdictOf } from "./verdict";

const check = (status: CheckResult["status"], id = "x"): CheckResult => ({ id, title: id, subject: "сценарий", status, details: "" });

describe("standCheck", () => {
  it("обычный прогон — стенд работал", () => {
    expect(standCheck(scenarioRun()).status).toBe("pass");
  });

  it("сбой провайдера без запасного пути, ошибка прогона, ответ персонажу не от закреплённого поставщика — стенд сломан", () => {
    const route = { model: "z-ai/glm-5.3-flash", provider: "friendli", temperature: 0.7, requests: 3, served: { Friendli: 2, Fireworks: 1 }, offRoute: 1, failed: 0 };
    const cases: Array<[Partial<ScenarioRun>, string]> = [
      [{ agentLogErrors: ["модель deepseek-v4-flash (deepseek): Credit limit exceeded"] }, "Credit limit"],
      [{ agentLogErrors: ["модель deepseek-v4-flash (deepseek): 503 Service Unavailable"] }, "503"],
      [{ runnerErrors: ["Публикация: connect ECONNREFUSED 127.0.0.1:55439"] }, "ECONNREFUSED"],
      [{ personaRoute: route }, "Fireworks"],
      [{ clients: [clientRun({ endedBy: "error", error: "Персонаж не ответил: error (overloaded)" })] }, "Персонаж не ответил"],
    ];
    for (const [overrides, detail] of cases) {
      const result = standCheck(scenarioRun(overrides));
      expect(result.status).toBe("stand_broke");
      expect(result.details).toContain(detail);
    }
  });

  it("ошибка инструмента и сбой, который закрыл запасной путь, — не поломка стенда", () => {
    const run = scenarioRun({ agentLogErrors: ["инструмент person_link_view: Отказ: уже 3 просмотра ссылок"], agentLogRecovered: ["модель m (together → deepseek): Credit limit exceeded"] });
    expect(standCheck(run).status).toBe("pass");
    expect(standCheck(scenarioRun({ runnerErrors: ["Удаление базы: timeout"] })).status).toBe("pass");
  });

  it("входит в проверки сценария", () => {
    expect(checkScenario(scenarioRun()).map((item) => item.id)).toContain("stand_ok");
  });
});

describe("verdictOf", () => {
  it("стенд главнее сбоя персонажа, тот главнее провала; успех — ни одного ❌", () => {
    expect(verdictOf([check("pass"), check("skip")])).toBe("pass");
    expect(verdictOf([check("pass"), check("fail")])).toBe("fail");
    expect(verdictOf([check("fail"), check("persona_broke")])).toBe("persona");
    expect(verdictOf([check("persona_broke"), check("stand_broke")])).toBe("stand");
  });
});

describe("tallyRepeats", () => {
  const outcome = (id: string, kind: "normal" | "provocateur", statuses: CheckResult["status"][], repeat: number) => {
    const base = scenarioRun();
    return { run: scenarioRun({ scenario: { ...base.scenario, id, kind } }), checks: statuses.map((status) => check(status)), repeat };
  };

  it("по сценарию — k из засчитанных и pass^N; исключённые повторы видны отдельно", () => {
    const tally = tallyRepeats(
      [
        outcome("normal-yoga", "normal", ["pass"], 1),
        outcome("normal-yoga", "normal", ["pass"], 2),
        outcome("normal-yoga", "normal", ["pass"], 3),
        outcome("provocateur-x", "provocateur", ["pass"], 1),
        outcome("provocateur-x", "provocateur", ["fail"], 2),
        outcome("provocateur-x", "provocateur", ["persona_broke"], 3),
      ],
      [],
      3,
    );
    expect(tally.scenarios).toEqual([
      expect.objectContaining({ id: "normal-yoga", kind: "normal", passed: 3, counted: 3, persona: 0, stand: 0, passAll: true }),
      expect.objectContaining({ id: "provocateur-x", kind: "provocateur", passed: 1, counted: 2, persona: 1, stand: 0, passAll: false }),
    ]);
  });

  it("засчитано меньше N без провалов — pass^N не известен; упавший целиком повтор — сломанный стенд", () => {
    const tally = tallyRepeats([outcome("normal-yoga", "normal", ["pass"], 1), outcome("normal-yoga", "normal", ["stand_broke"], 2)], [{ id: "normal-yoga", kind: "normal", repeat: 3, error: "база недоступна" }], 3);
    expect(tally.scenarios[0]).toMatchObject({ passed: 1, counted: 1, stand: 2, passAll: null });
  });

  it("итоги по уровням: сумма k/n и сколько сценариев прошли все N раз", () => {
    const tally = tallyRepeats(
      [
        outcome("normal-a", "normal", ["pass"], 1),
        outcome("normal-a", "normal", ["pass"], 2),
        outcome("normal-b", "normal", ["fail"], 1),
        outcome("normal-b", "normal", ["pass"], 2),
        outcome("provocateur-x", "provocateur", ["pass"], 1),
        outcome("provocateur-x", "provocateur", ["pass"], 2),
      ],
      [],
      2,
    );
    expect(tally.kinds).toEqual([
      { kind: "normal", scenarios: 2, passed: 3, counted: 4, persona: 0, stand: 0, passAll: 1, passAllKnown: 2 },
      { kind: "provocateur", scenarios: 1, passed: 2, counted: 2, persona: 0, stand: 0, passAll: 1, passAllKnown: 1 },
    ]);
  });

  it("итоги по наборам: сценарии «на рост», «на поломки» и отложенные считаются отдельно", () => {
    const inSet = (id: string, set: "growth" | "regression" | "holdout", status: CheckResult["status"], repeat: number) => {
      const base = scenarioRun();
      return { run: scenarioRun({ scenario: { ...base.scenario, id, set } }), checks: [check(status)], repeat };
    };
    const tally = tallyRepeats(
      [
        inSet("grow-a", "growth", "fail", 1),
        inSet("grow-a", "growth", "pass", 2),
        inSet("keep-b", "regression", "pass", 1),
        inSet("keep-b", "regression", "pass", 2),
        inSet("hold-c", "holdout", "pass", 1),
        inSet("hold-c", "holdout", "persona_broke", 2),
      ],
      [],
      2,
    );
    expect(tally.scenarios.map((item) => `${item.id}:${item.set}`)).toEqual(["grow-a:growth", "keep-b:regression", "hold-c:holdout"]);
    expect(tally.sets).toEqual([
      { set: "growth", scenarios: 1, passed: 1, counted: 2, persona: 0, stand: 0, passAll: 0, passAllKnown: 1 },
      { set: "regression", scenarios: 1, passed: 2, counted: 2, persona: 0, stand: 0, passAll: 1, passAllKnown: 1 },
      { set: "holdout", scenarios: 1, passed: 1, counted: 1, persona: 1, stand: 0, passAll: 0, passAllKnown: 0 },
    ]);
  });
});
