import { describe, expect, it } from "vitest";
import { FIRST_APP_FIELDS, firstAppSettings } from "./first-app.fixture";
import { leadMagnetToFlow } from "./settings-to-flow";
import { leadMagnetFlowIssues, validateLeadMagnetFlow } from "./validate-flow";

const firstAppJson = () => JSON.parse(JSON.stringify(leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS)));

describe("validateLeadMagnetFlow: разбор, проверка SDK и наши проверки одной цепочкой", () => {
  it("верный сценарий — разобранный, со значениями по умолчанию", () => {
    const json = firstAppJson();
    delete json.states[0].kind;
    const result = validateLeadMagnetFlow(json);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flow.states[0]!.kind).toBe("state");
  });

  it("ошибка формы — с путём внутри сценария", () => {
    const json = firstAppJson();
    json.states[2].exits[0].when = { type: "judge" };
    const result = validateLeadMagnetFlow(json);
    expect(result).toEqual({ ok: false, issues: [{ path: "states[2].exits[0].when.text", message: expect.any(String) }] });
  });

  it("ошибка связей SDK — с путём по месту находки", () => {
    const json = firstAppJson();
    json.states[1].exits[0].to = "nowhere";
    const result = validateLeadMagnetFlow(json);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues).toContainEqual({ path: "states[1].exits[0]", message: expect.stringMatching(/«nowhere», которого нет/) });
  });

  it("мягкая рамка не меньше жёсткой — ошибка проверки SDK", () => {
    const json = firstAppJson();
    json.schedule.dayFrame.softFrom = 30;
    const result = validateLeadMagnetFlow(json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toEqual([{ path: "schedule", message: expect.stringMatching(/мягкая рамка/) }]);
  });

  it("наша находка — со своим путём", () => {
    const json = firstAppJson();
    json.afterEnd = "reply";
    expect(validateLeadMagnetFlow(json)).toEqual({ ok: false, issues: [{ path: "afterEnd", message: expect.stringMatching(/молч/) }] });
  });

  it("замечания SDK (не ошибки) сохранению не мешают", () => {
    const json = firstAppJson();
    json.nudges = { afterSilence: [{ amount: 1, unit: "h" }] };
    expect(validateLeadMagnetFlow(json).ok).toBe(true);
  });

  it("не сценарий — понятная ошибка", () => {
    expect(validateLeadMagnetFlow(undefined)).toEqual({ ok: false, issues: [{ path: "", message: expect.stringMatching(/объект JSON/) }] });
  });
});

describe("leadMagnetFlowIssues: все находки с уровнем — для конструктора", () => {
  it("замечания SDK тоже видны, с путём и уровнем", () => {
    const flow = leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS);
    flow.nudges = { afterSilence: [{ amount: 1, unit: "h" }] };
    expect(leadMagnetFlowIssues(flow)).toContainEqual({ level: "warning", path: "", message: expect.stringMatching(/Дней и времени/) });
  });

  it("верный сценарий без замечаний — пусто", () => {
    expect(leadMagnetFlowIssues(leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS))).toEqual([]);
  });
});
