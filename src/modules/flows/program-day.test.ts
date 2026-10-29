import { checkFlow, parseFlow, type AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { describe, expect, it } from "vitest";
import firstApp from "../../../docs/lead-magnets/first-app.json";
import sixStates from "../../../docs/lead-magnets/history/first-app-six-states.json";
import { leadMagnetFlowChecks } from "./app-checks";
import { leadMagnetFlowCatalog } from "./catalog";
import { completeFlowJson } from "./flow-settings";
import { FIRST_APP_FIELDS, firstAppSettings } from "./first-app.fixture";
import { withProgramDaySale, withProgramDayTimers } from "./program-day";
import { PROGRAM_NUDGES, leadMagnetToFlow } from "./settings-to-flow";

const SALE_DAY_3 = { type: "timer", from: "program_day", day: 3 } as const;

const exitsTo = (flow: AgentFlow, to: string) => flow.states.flatMap((state) => state.exits.filter((exit) => exit.to === to).map((exit) => ({ from: state.id, ...exit })));

/** Ноды и «Дни и время» «Твоего первого приложения» из docs/lead-magnets/first-app.json — как его грузит eval; поля карточки там по названиям, они здесь не нужны. */
function firstAppJsonFlow(source: { flow: Record<string, unknown> } = firstApp): AgentFlow {
  const parsed = parseFlow(completeFlowJson({ ...structuredClone(source.flow), clientCard: [], sideTasks: [] }, leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.flow;
}

/** То же, как оно было до 14.10: ноды первого дня — «длится 1 день» в «Доработку», из неё в «Продажу» — «длится 1 день». */
function oldFirstAppFlow(): AgentFlow {
  const flow = firstAppJsonFlow(sixStates);
  for (const state of flow.states) {
    const day3 = state.exits.findIndex((exit) => exit.id === `${state.id}_day3`);
    if (day3 === -1) continue;
    state.exits[day3] =
      state.id === "polish"
        ? { ...state.exits[day3]!, when: { type: "timer", from: "state_days", days: 1 } }
        : { id: `${state.id}_days`, when: { type: "timer", from: "state_days", days: 1 }, to: "polish" };
  }
  return flow;
}

describe("«Продажа» не раньше своего дня программы", () => {
  it("перевод старых настроек: в «Продажу» по сроку — таймер «день N программы» её начала из каждой ноды до неё, а не «нода длится N дней»", () => {
    const flow = leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS);
    const sale = firstAppSettings().stages.find((stage) => stage.isSale)!;
    const timed = exitsTo(flow, sale.id).filter((exit) => exit.when.type !== "judge");
    expect(timed.map((exit) => exit.from)).toEqual(firstAppSettings().stages.filter((stage) => !stage.isSale).map((stage) => stage.id));
    for (const exit of timed) expect(exit.when).toEqual({ type: "timer", from: "program_day", day: sale.startDay });
    expect(checkFlow(flow, leadMagnetFlowCatalog(FIRST_APP_FIELDS), { checks: leadMagnetFlowChecks }).filter((issue) => issue.level === "error")).toEqual([]);
  });

  it("старый сценарий с «длится 1 день» перед «Продажей»: срок становится таймером «день 3 программы» — того дня, когда туда приходит молчун", () => {
    const fixed = withProgramDaySale(oldFirstAppFlow());
    expect(exitsTo(fixed, "course").filter(({ from }) => from === "polish").map(({ from, id, when }) => ({ from, id, when }))).toEqual([
      { from: "polish", id: "polish_done", when: expect.objectContaining({ type: "judge" }) },
      { from: "polish", id: "polish_day3", when: SALE_DAY_3 },
    ]);
    // Остальные ноды не тронуты
    expect(fixed.states.filter((state) => state.id !== "polish")).toEqual(oldFirstAppFlow().states.filter((state) => state.id !== "polish"));
  });

  it("сценарий без «Дней и времени» и уже исправленный (first-app.json) — тот же объект", () => {
    const plain = leadMagnetToFlow({ ...firstAppSettings(), program: null }, FIRST_APP_FIELDS);
    expect(withProgramDaySale(plain)).toBe(plain);
    const current = firstAppJsonFlow();
    expect(withProgramDaySale(current)).toBe(current);
  });

  it("сценарий с событием program_day_N (до SDK 0.55) — таймер «день N программы»; прочие выходы не тронуты", () => {
    const current = firstAppJsonFlow();
    const legacy = structuredClone(current);
    for (const state of legacy.states)
      for (const exit of state.exits)
        if (exit.when.type === "timer" && exit.when.from === "program_day") exit.when = { type: "event", event: "app", name: `program_day_${exit.when.day}` };
    expect(legacy).not.toEqual(current);
    expect(withProgramDayTimers(legacy)).toEqual(current);
    expect(withProgramDayTimers(current)).toBe(current);
  });

  it("событие приложения не про день программы не трогается", () => {
    const flow = firstAppJsonFlow();
    flow.states[0]!.exits.push({ id: "paid", when: { type: "event", event: "app", name: "paid" }, to: "course" });
    expect(withProgramDayTimers(flow)).toBe(flow);
  });
});

describe("касания молчуну в «Твоём первом приложении» (first-app.json)", () => {
  it("потолок по дням программы: день 1 — три, со дня 2 — два; частые касания нод — только в день входа и только в день 1", () => {
    const flow = firstAppJsonFlow();
    expect(flow.schedule?.firstMessages?.maxPerDayByDay).toEqual([3, 2]);
    expect(flow.schedule?.nudges).toEqual(PROGRAM_NUDGES);
    const own = flow.states.flatMap((state) => (state.nudges && state.nudges !== "off" ? [state.nudges] : []));
    expect(own.length).toBeGreaterThan(0);
    for (const nudges of own) expect(nudges).toMatchObject({ days: 1, untilProgramDay: 1 });
  });
});
