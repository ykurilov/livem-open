import type { AgentFlow, FlowAppIssue } from "@ykurilov/agent-chat-flows/format";
import { describe, expect, it } from "vitest";
import { leadMagnetFlowChecks } from "./app-checks";
import { LEAD_MAGNET_TOOLS } from "./catalog";
import { FIRST_APP_FIELDS, firstAppSettings } from "./first-app.fixture";
import { SALE_TAG, leadMagnetToFlow } from "./settings-to-flow";

/** Переведённое «Твоё первое приложение»: все наши проверки проходит. Правка — копия. */
function firstAppFlow(edit: (flow: AgentFlow) => void = () => {}): AgentFlow {
  const flow = structuredClone(leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS));
  edit(flow);
  return flow;
}

const stateIndex = (flow: AgentFlow, id: string) => flow.states.findIndex((state) => state.id === id);
const paths = (issues: readonly FlowAppIssue[]) => issues.map((issue) => issue.path);

describe("leadMagnetFlowChecks", () => {
  it("переведённый лидмагнит без находок", () => {
    expect(leadMagnetFlowChecks(firstAppFlow())).toEqual([]);
  });

  it("выход по времени в ноду, куда приходят по результату, — предупреждение: человек попадёт туда без результата", () => {
    // Старый автоперенос: «Идея» длится 1 день → «Доработка», а в «Доработку» приходят после «Публикации»
    const flow = firstAppFlow((draft) => {
      draft.states[stateIndex(draft, "stage-1")]!.exits.push({ id: "idea_days", when: { type: "timer", from: "state_days", days: 1 }, to: "stage-5" });
    });
    expect(leadMagnetFlowChecks(flow)).toEqual([
      {
        level: "warning",
        path: `states[${stateIndex(flow, "stage-1")}].exits[${flow.states[stateIndex(flow, "stage-1")]!.exits.length - 1}]`,
        message: expect.stringMatching(/по времени.*Доработ.*по результату/s),
      },
    ]);
  });

  it("выход по времени в ту же ноду, куда ведёт результат этой ноды, — тоже предупреждение", () => {
    const flow = firstAppFlow((draft) => {
      draft.states[stateIndex(draft, "stage-4")]!.exits.push({ id: "publish_days", when: { type: "timer", from: "state_days", days: 1 }, to: "stage-5" });
    });
    expect(leadMagnetFlowChecks(flow)).toMatchObject([{ level: "warning", path: expect.stringMatching(/^states\[3\]\.exits/) }]);
  });

  it("срок в «Продажу» и выход по времени в ноду, куда результатом не прийти, — без предупреждения", () => {
    const flow = firstAppFlow((draft) => {
      draft.states[stateIndex(draft, "stage-5")]!.exits.push({ id: "polish_back", when: { type: "timer", from: "state_days", days: 1 }, to: "stage-1" });
    });
    expect(leadMagnetFlowChecks(flow)).toEqual([]);
  });

  it("«Продажа» только в одной ноде", () => {
    const flow = firstAppFlow((draft) => {
      const polish = draft.states[stateIndex(draft, "stage-5")]!;
      polish.tags = [SALE_TAG];
      polish.tools = [...polish.tools, LEAD_MAGNET_TOOLS.saleAnswer];
    });
    const issues = leadMagnetFlowChecks(flow);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: `states[${stateIndex(flow, "stage-6")}]`, message: expect.stringMatching(/«Продажа» — только в одной ноде/) });
  });

  it("у ноды «Продажа» есть sale_answer; sale_answer — только в «Продаже»", () => {
    const noTool = firstAppFlow((draft) => {
      const sale = draft.states[stateIndex(draft, "stage-6")]!;
      sale.tools = sale.tools.filter((tool) => tool !== LEAD_MAGNET_TOOLS.saleAnswer);
    });
    expect(leadMagnetFlowChecks(noTool)).toEqual([
      { path: `states[${stateIndex(noTool, "stage-6")}]`, message: expect.stringMatching(/sale_answer/) },
    ]);

    const elsewhere = firstAppFlow((draft) => {
      const idea = draft.states[stateIndex(draft, "stage-1")]!;
      idea.tools = [...idea.tools, LEAD_MAGNET_TOOLS.saleAnswer];
    });
    expect(leadMagnetFlowChecks(elsewhere)).toEqual([
      { path: "states[0]", message: expect.stringMatching(/sale_answer — только в ноде «Продажа»/) },
    ]);
  });

  it("срок программы — от 2 до 14 дней и задан всегда, когда есть «Дни и время»", () => {
    for (const lengthDays of [1, 15]) {
      const flow = firstAppFlow((draft) => (draft.schedule!.lengthDays = lengthDays));
      expect(paths(leadMagnetFlowChecks(flow))).toEqual(["schedule.lengthDays"]);
    }
    const noLength = firstAppFlow((draft) => delete draft.schedule!.lengthDays);
    expect(leadMagnetFlowChecks(noLength)).toEqual([{ path: "schedule.lengthDays", message: expect.stringMatching(/от 2 до 14/) }]);
    expect(leadMagnetFlowChecks(firstAppFlow((draft) => (draft.schedule!.lengthDays = 14)))).toEqual([]);
  });

  it("начало дня — не раньше 5:00", () => {
    const flow = firstAppFlow((draft) => (draft.schedule!.dayStart = "04:30"));
    expect(leadMagnetFlowChecks(flow)).toEqual([{ path: "schedule.dayStart", message: expect.stringMatching(/не раньше 5:00/) }]);
    expect(leadMagnetFlowChecks(firstAppFlow((draft) => (draft.schedule!.dayStart = "05:00")))).toEqual([]);
  });

  it("у стартовой ноды нет своего первого сообщения: оно в «Настройках»", () => {
    const flow = firstAppFlow((draft) => (draft.states[0]!.firstMessage = "Привет!"));
    expect(leadMagnetFlowChecks(flow)).toEqual([{ path: "states[0].firstMessage", message: expect.stringMatching(/«Настройк/) }]);
    // У других нод своё первое сообщение можно
    expect(leadMagnetFlowChecks(firstAppFlow((draft) => (draft.states[1]!.firstMessage = "Дальше!")))).toEqual([]);
  });

  it("поле попутной задачи — из карточки клиента, а не из заметок чата", () => {
    const flow = firstAppFlow((draft) => {
      draft.chatNotes = [{ id: "note", name: "Заметка", about: "", type: "text", options: [] }];
      draft.sideTasks![1]!.field = "note";
    });
    expect(leadMagnetFlowChecks(flow)).toEqual([{ path: "sideTasks[1].field", message: expect.stringMatching(/карточк/) }]);
  });

  it("после конца разговора — только «молчать»", () => {
    for (const afterEnd of ["reply", undefined] as const) {
      const flow = firstAppFlow((draft) => (draft.afterEnd = afterEnd));
      expect(leadMagnetFlowChecks(flow)).toEqual([{ path: "afterEnd", message: expect.stringMatching(/молч/) }]);
    }
  });

  it("готовые тексты без подстановок: прощание при «срок вышел» и фраза жёсткой рамки", () => {
    const farewell = firstAppFlow((draft) => {
      draft.schedule!.farewellOnDeadline = true;
      draft.schedule!.farewellText = "Спасибо, {имя}!";
    });
    expect(leadMagnetFlowChecks(farewell)).toEqual([{ path: "schedule.farewellText", message: expect.stringMatching(/«\{имя\}»/) }]);
    const hard = firstAppFlow((draft) => (draft.schedule!.dayFrame!.hardText = "До завтра, {name}"));
    expect(paths(leadMagnetFlowChecks(hard))).toEqual(["schedule.dayFrame.hardText"]);
  });

  it("прощание при «срок вышел» с готовым текстом проходит", () => {
    const flow = firstAppFlow((draft) => {
      draft.schedule!.farewellOnDeadline = true;
      draft.schedule!.farewellText = "Наша трёхдневка закончилась, спасибо, что были с нами!";
    });
    expect(leadMagnetFlowChecks(flow)).toEqual([]);
  });

  it("сообщений первым — не больше 3 в день", () => {
    const flow = firstAppFlow((draft) => (draft.schedule!.firstMessages = { maxPerDay: 4 }));
    expect(leadMagnetFlowChecks(flow)).toEqual([
      { path: "schedule.firstMessages.maxPerDay", message: expect.stringMatching(/не больше 3 в день/) },
    ]);
    expect(leadMagnetFlowChecks(firstAppFlow((draft) => (draft.schedule!.firstMessages = { maxPerDay: 3 })))).toEqual([]);
  });

  it("потолок по дням программы: в день 1 — не больше 3, со дня 2 — не больше 2", () => {
    const at = (maxPerDayByDay: number[]) =>
      leadMagnetFlowChecks(firstAppFlow((draft) => (draft.schedule!.firstMessages = { maxPerDayByDay })));
    expect(at([3, 2])).toEqual([]);
    expect(at([2, 1, 1])).toEqual([]);
    expect(at([4, 2])).toEqual([{ path: "schedule.firstMessages.maxPerDayByDay[0]", message: expect.stringMatching(/не больше 3/) }]);
    expect(at([3, 2, 3])).toEqual([{ path: "schedule.firstMessages.maxPerDayByDay[2]", message: expect.stringMatching(/не больше 2/) }]);
  });

  it("частые касания ноды в программе без «до дня программы» — предупреждение: повторятся в любой день входа", () => {
    const flow = firstAppFlow((draft) => {
      const nudges = draft.states[0]!.nudges;
      if (nudges && nudges !== "off") delete nudges.untilProgramDay;
    });
    expect(leadMagnetFlowChecks(flow)).toEqual([
      { level: "warning", path: "states[0].nudges", message: expect.stringMatching(/до дня воронки/) },
    ]);
  });

  it("касания ноды: не больше 5 в ряду и не чаще раза в 10 минут — ошибка у ноды на доске", () => {
    const many = firstAppFlow((draft) => {
      draft.states[1]!.nudges = { afterSilence: Array.from({ length: 6 }, () => ({ amount: 1, unit: "h" as const })) };
    });
    expect(leadMagnetFlowChecks(many)).toEqual([
      { path: "states[1].nudges.afterSilence", message: expect.stringMatching(/^«.+»: .*не больше 5/) },
    ]);
    const often = firstAppFlow((draft) => {
      draft.states[1]!.nudges = { afterSilence: [{ amount: 15, unit: "min" }, { amount: 0.1, unit: "h" }] };
    });
    expect(leadMagnetFlowChecks(often)).toEqual([
      { path: "states[1].nudges.afterSilence[1]", message: expect.stringMatching(/не чаще раза в 10 минут/) },
    ]);
    const fine = firstAppFlow((draft) => {
      draft.states[1]!.nudges = { afterSilence: Array.from({ length: 5 }, () => ({ amount: 10, unit: "min" as const })) };
    });
    expect(leadMagnetFlowChecks(fine)).toEqual([]);
  });

  it("касания по часам: не больше 2 в день (молчуну со второго дня — не больше двух) и не ближе 10 минут друг к другу", () => {
    const many = firstAppFlow((draft) => (draft.nudges = { afterSilence: [], dailyAt: ["09:00", "12:00", "15:00"] }));
    expect(leadMagnetFlowChecks(many)).toEqual([{ path: "nudges.dailyAt", message: expect.stringMatching(/не больше 2/) }]);
    expect(leadMagnetFlowChecks(firstAppFlow((draft) => (draft.nudges = { afterSilence: [], dailyAt: ["10:00", "19:00"] })))).toEqual([]);
    const close = firstAppFlow((draft) => (draft.schedule!.nudges = { afterSilence: [{ amount: 3, unit: "h" }], dailyAt: ["19:05", "19:00"] }));
    expect(leadMagnetFlowChecks(close)).toEqual([{ path: "schedule.nudges.dailyAt", message: expect.stringMatching(/10 минут/) }]);
  });

  it("касания сценария и «Дней и времени» проверяются так же, как у ноды", () => {
    const flow = firstAppFlow((draft) => (draft.schedule!.nudges = { afterSilence: [{ amount: 5, unit: "min" }] }));
    expect(paths(leadMagnetFlowChecks(flow))).toEqual(["schedule.nudges.afterSilence[0]"]);
  });
});
