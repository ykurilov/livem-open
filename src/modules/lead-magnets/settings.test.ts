import { describe, expect, it } from "vitest";
import {
  InvalidLeadMagnetSettingsError,
  newLeadMagnetSettings,
  newProgramSettings,
  validateLeadMagnetSettings,
  type LeadMagnetSettings,
} from "./settings";

describe("проверка настроек лидмагнита", () => {
  it("повторы id роликов убираются, порядок первого появления сохраняется", () => {
    const a = "00000000-0000-4000-8000-00000000000a";
    const b = "00000000-0000-4000-8000-00000000000b";
    const settings = validateLeadMagnetSettings({ ...newLeadMagnetSettings("Разбор"), videoIds: [a, b, a, b] });
    expect(settings.videoIds).toEqual([a, b]);
  });

  it("повторы id картинок убираются; настройки, сохранённые до архива картинок, читаются без картинок", () => {
    const a = "00000000-0000-4000-8000-00000000000a";
    const b = "00000000-0000-4000-8000-00000000000b";
    expect(validateLeadMagnetSettings({ ...newLeadMagnetSettings("Разбор"), imageIds: [a, b, a] }).imageIds).toEqual([a, b]);
    const { imageIds: _skipped, ...saved } = newLeadMagnetSettings("Разбор");
    expect(validateLeadMagnetSettings(saved).imageIds).toEqual([]);
  });

  it("подстановка в фигурных скобках в прощании или первом сообщении — понятная ошибка", () => {
    const base = newLeadMagnetSettings("Разбор");
    expect(() => validateLeadMagnetSettings({ ...base, farewellMessage: "Спасибо, {имя}!" })).toThrow(
      /прощальном сообщении есть «\{имя\}»/,
    );
    expect(() => validateLeadMagnetSettings({ ...base, firstMessage: "Привет, {name}! Как дела?" })).toThrow(
      /первом сообщении есть «\{name\}»/,
    );
    expect(() => validateLeadMagnetSettings({ ...base, farewellMessage: "Спасибо, {имя}!" })).toThrow(/увидит её как есть/);
    expect(validateLeadMagnetSettings({ ...base, firstMessage: "Привет! Как дела?", farewellMessage: "Спасибо!" }).farewellMessage).toBe(
      "Спасибо!",
    );
  });
});

const FIELD_ID = "00000000-0000-4000-8000-0000000000f1";

function stage(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, instruction: "", transitionCondition: "", startDay: null, isSale: false, ...extra };
}

/** Лидмагнит с программой на 3 дня и тремя этапами. */
function withProgram(patch: Partial<LeadMagnetSettings> = {}): LeadMagnetSettings {
  return {
    ...newLeadMagnetSettings("Программа"),
    program: newProgramSettings(3),
    stages: [stage("hello"), stage("practice", { startDay: 2 }), stage("sale", { startDay: 3, isSale: true })],
    fieldIds: [FIELD_ID],
    ...patch,
  };
}

describe("программа на несколько дней", () => {
  it("по умолчанию программы нет: лидмагнит работает как раньше", () => {
    expect(newLeadMagnetSettings("Разбор").program).toBeNull();
  });

  it("настройки, записанные до программы, читаются: программы нет, у этапов нет дня и отметки «Продажа»", () => {
    const { program: _program, ...legacy } = newLeadMagnetSettings("Старый");
    const settings = validateLeadMagnetSettings({
      ...legacy,
      stages: [{ id: "a", name: "Знакомство", instruction: "", transitionCondition: "" }],
    });
    expect(settings.program).toBeNull();
    expect(settings.stages[0]).toMatchObject({ startDay: null, isSale: false });
  });

  it("программа по умолчанию — значения из спецификации", () => {
    expect(newProgramSettings(3)).toEqual({
      days: 3,
      softDailyMessages: 20,
      hardDailyMessages: 30,
      outreach: {
        morningAt: "10:00",
        afterSilenceHours: [3, 3],
        firstDayAfterSilenceMinutes: [15, 60, 240],
        maxPerDay: 3,
        latestAt: "21:00",
      },
      sideTasks: [],
    });
  });

  it("правильная программа с днями этапов, «Продажей» и попутными задачами проходит проверку", () => {
    const settings = withProgram();
    settings.program!.sideTasks = [{ id: "city", task: "Узнать город", fieldId: FIELD_ID, when: "" }];
    expect(validateLeadMagnetSettings(settings)).toEqual(settings);
  });

  it("срок — от 2 до 14 дней, целое число", () => {
    for (const days of [1, 15, 2.5, 0]) {
      const settings = withProgram();
      settings.program!.days = days;
      settings.stages = [stage("hello")];
      expect(() => validateLeadMagnetSettings(settings), `срок ${days}`).toThrow(/срок/i);
    }
    for (const days of [2, 14]) {
      const settings = withProgram();
      settings.program!.days = days;
      settings.stages = [stage("hello")];
      expect(validateLeadMagnetSettings(settings).program!.days).toBe(days);
    }
  });

  it("мягкая рамка дня меньше жёсткой", () => {
    const settings = withProgram();
    settings.program!.softDailyMessages = 30;
    settings.program!.hardDailyMessages = 30;
    expect(() => validateLeadMagnetSettings(settings)).toThrow(/мягкая рамка/i);
    settings.program!.softDailyMessages = 31;
    expect(() => validateLeadMagnetSettings(settings)).toThrow(/мягкая рамка/i);
    settings.program!.softDailyMessages = 29;
    expect(validateLeadMagnetSettings(settings).program!.softDailyMessages).toBe(29);
  });

  it("время утра и последнее время — ЧЧ:ММ, утро не раньше 5:00 и раньше последнего", () => {
    const bad = (patch: Partial<NonNullable<LeadMagnetSettings["program"]>["outreach"]>) => {
      const settings = withProgram();
      settings.program!.outreach = { ...settings.program!.outreach, ...patch };
      return () => validateLeadMagnetSettings(settings);
    };
    expect(bad({ morningAt: "10" })).toThrow(/ЧЧ:ММ/);
    expect(bad({ latestAt: "25:00" })).toThrow(/ЧЧ:ММ/);
    expect(bad({ morningAt: "04:30" })).toThrow(/5:00/);
    expect(bad({ morningAt: "21:00", latestAt: "21:00" })).toThrow(/раньше/);
    expect(bad({ morningAt: "22:00", latestAt: "21:00" })).toThrow(/раньше/);
    expect(bad({ morningAt: "05:00", latestAt: "23:30" })).not.toThrow();
  });

  it("расписание сообщений при молчании: положительные числа, потолок дня целый и больше нуля", () => {
    const bad = (patch: Partial<NonNullable<LeadMagnetSettings["program"]>["outreach"]>) => {
      const settings = withProgram();
      settings.program!.outreach = { ...settings.program!.outreach, ...patch };
      return () => validateLeadMagnetSettings(settings);
    };
    expect(bad({ afterSilenceHours: [3, 0] })).toThrow();
    expect(bad({ afterSilenceHours: [-1] })).toThrow();
    expect(bad({ firstDayAfterSilenceMinutes: [15, 10] })).toThrow(/по возрастанию/);
    expect(bad({ firstDayAfterSilenceMinutes: [0, 60] })).toThrow();
    expect(bad({ maxPerDay: 0 })).toThrow();
    expect(bad({ maxPerDay: 1.5 })).toThrow();
    expect(bad({ afterSilenceHours: [], firstDayAfterSilenceMinutes: [] })).not.toThrow();
  });

  it("день начала этапа — только при программе", () => {
    const settings = withProgram({ program: null });
    expect(() => validateLeadMagnetSettings(settings)).toThrow(/воронк/i);
  });

  it("день начала этапа не больше срока программы и не меньше 1", () => {
    expect(() => validateLeadMagnetSettings(withProgram({ stages: [stage("a"), stage("b", { startDay: 4 })] }))).toThrow(/день 4/);
    expect(() => validateLeadMagnetSettings(withProgram({ stages: [stage("a"), stage("b", { startDay: 0 })] }))).toThrow();
    expect(validateLeadMagnetSettings(withProgram({ stages: [stage("a"), stage("b", { startDay: 3 })] })).stages[1]!.startDay).toBe(3);
  });

  it("дни этапов не убывают; этапы без дня порядок не нарушают", () => {
    expect(() =>
      validateLeadMagnetSettings(withProgram({ stages: [stage("a", { startDay: 3 }), stage("b", { startDay: 2 })] })),
    ).toThrow(/не убывают|позже/);
    expect(
      validateLeadMagnetSettings(withProgram({ stages: [stage("a", { startDay: 2 }), stage("b"), stage("c", { startDay: 2 })] })).stages,
    ).toHaveLength(3);
  });

  it("«Продажа» — не больше чем у одного этапа", () => {
    expect(() =>
      validateLeadMagnetSettings(withProgram({ stages: [stage("a", { isSale: true }), stage("b", { isSale: true })] })),
    ).toThrow(/«Продажа»/);
  });

  it("поле попутной задачи — из подключённых к лидмагниту полей", () => {
    const settings = withProgram();
    settings.program!.sideTasks = [{ id: "city", task: "Узнать город", fieldId: "00000000-0000-4000-8000-0000000000aa", when: "" }];
    expect(() => validateLeadMagnetSettings(settings)).toThrow(/поле/i);
    settings.program!.sideTasks = [{ id: "review", task: "Попросить отзыв", fieldId: null, when: "когда доволен" }];
    expect(validateLeadMagnetSettings(settings).program!.sideTasks).toHaveLength(1);
  });

  it("у попутных задач непустой текст и уникальные id", () => {
    const settings = withProgram();
    settings.program!.sideTasks = [{ id: "a", task: "  ", fieldId: null, when: "" }];
    expect(() => validateLeadMagnetSettings(settings)).toThrow(/попутн/i);
    settings.program!.sideTasks = [
      { id: "a", task: "Узнать город", fieldId: null, when: "" },
      { id: "a", task: "Попросить отзыв", fieldId: null, when: "" },
    ];
    expect(() => validateLeadMagnetSettings(settings)).toThrow(/повторяются/);
  });
});

describe("сценарий лидмагнита (поле flow)", () => {
  it("новый лидмагнит сразу со сценарием: одна нода «Разговор», напоминания бросившим, после конца — молчать", () => {
    const { flow } = newLeadMagnetSettings("Разбор");
    expect(flow.name).toBe("Разбор");
    expect(flow.states.map((state) => state.title)).toEqual(["Разговор", "Итог"]);
    expect(flow.nudges?.giveUpAfter).toEqual({ amount: 3, unit: "d" });
    expect(flow.afterEnd).toBe("silent");
    expect(validateLeadMagnetSettings(newLeadMagnetSettings("Разбор")).flow).toEqual(flow);
  });

  it("сценарий из JSON дополняется значениями по умолчанию", () => {
    const base = newLeadMagnetSettings("Разбор");
    const json = JSON.parse(JSON.stringify(base.flow));
    delete json.pace;
    delete json.states[0].kind;
    const checked = validateLeadMagnetSettings({ ...base, flow: json });
    expect(checked.flow).toEqual(base.flow);
  });

  it("настройки без сценария не проходят", () => {
    const { flow: _flow, ...withoutFlow } = newLeadMagnetSettings("Разбор");
    expect(() => validateLeadMagnetSettings(withoutFlow)).toThrow(InvalidLeadMagnetSettingsError);
  });

  it("ошибка сценария — с путём от корня настроек, в тексте и в списке issues", () => {
    const base = newLeadMagnetSettings("Разбор");
    const json = JSON.parse(JSON.stringify(base.flow));
    json.states[0].exits[0].when = { type: "judge" };
    json.afterEnd = "reply";
    let error: unknown;
    try {
      validateLeadMagnetSettings({ ...base, flow: json });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidLeadMagnetSettingsError);
    const issues = (error as InvalidLeadMagnetSettingsError).issues;
    expect(issues).toEqual([{ path: "flow.states[0].exits[0].when.text", message: expect.any(String) }]);
    expect((error as Error).message).toMatch(/«flow\.states\[0\]\.exits\[0\]\.when\.text»/);

    json.states[0].exits[0].when = { type: "event", event: "tool", name: "finish_dialog" };
    expect(() => validateLeadMagnetSettings({ ...base, flow: json })).toThrow(/«flow\.afterEnd»: .*молч/);
  });

  it("наши проверки сценария тоже работают при сохранении: «Продажа» без sale_answer", () => {
    const base = newLeadMagnetSettings("Разбор");
    const flow = structuredClone(base.flow);
    flow.states[0]!.tags = ["продажа"];
    expect(() => validateLeadMagnetSettings({ ...base, flow })).toThrow(/«flow\.states\[0\]»: .*sale_answer/);
  });

  it("ошибки старых полей — без путей сценария", () => {
    try {
      validateLeadMagnetSettings({ ...newLeadMagnetSettings("Разбор"), name: " " });
    } catch (error) {
      expect((error as InvalidLeadMagnetSettingsError).issues).toEqual([]);
      return;
    }
    throw new Error("Пустое название должно было не пройти");
  });
});
