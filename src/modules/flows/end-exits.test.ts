import type { AgentFlow, FlowExit } from "@ykurilov/agent-chat-flows/format";
import { describe, expect, it } from "vitest";
import { leadMagnetFlowChecks } from "./app-checks";
import { withFinishDialogEnds } from "./end-exits";
import { FIRST_APP_FIELDS, firstAppSettings } from "./first-app.fixture";
import { FINAL_STATE_ID, leadMagnetToFlow } from "./settings-to-flow";

const FINISH = { type: "event", event: "tool", name: "finish_dialog" } as const;

/** Сценарий конструктора из eval 14.10 (normal-yoga): выход словами из «Пробного занятия» прямо в «Итог». */
function yogaFlow(): AgentFlow {
  const flow = structuredClone(leadMagnetToFlow({ ...firstAppSettings(), stages: [], program: null }, FIRST_APP_FIELDS));
  const conversation = flow.states[0]!;
  conversation.id = "trial";
  flow.start = "trial";
  conversation.exits = [
    { id: "trial_done", when: { type: "judge", text: "Человек согласился на пробное и получил ссылку" }, to: FINAL_STATE_ID },
    { id: "trial_finish", when: FINISH, to: FINAL_STATE_ID },
  ];
  return flow;
}

const exitsOf = (flow: AgentFlow, id: string): FlowExit[] => flow.states.find((state) => state.id === id)!.exits;

describe("в конечную ноду — только finish_dialog или срок", () => {
  it("проверка сценария: выход словами, по данным или другим событием в «Итог» — ошибка с местом", () => {
    const flow = yogaFlow();
    flow.states[0]!.exits.push({ id: "trial_data", when: { type: "data", field: FIRST_APP_FIELDS[0]!.id, op: "filled" }, to: FINAL_STATE_ID });
    flow.anyState.exits.push({ id: "any_button", when: { type: "event", event: "button", name: "stop" }, to: FINAL_STATE_ID });
    const issues = leadMagnetFlowChecks(flow).filter((issue) => /finish_dialog/.test(issue.message));
    expect(issues.map((issue) => issue.path)).toEqual(["states[0].exits[0]", "states[0].exits[2]", "anyState.exits[1]"]);
    expect(issues[0]!.message).toMatch(/«Итог».*только.*finish_dialog/);
  });

  it("переход словами в рабочую ноду без выходов — подсказка: такая нода конечная, дай ей выход; у «Итога» подсказки нет", () => {
    const flow = yogaFlow();
    flow.states.splice(1, 0, { ...structuredClone(flow.states[0]!), id: "call", title: "Созвон", exits: [] });
    flow.states[0]!.exits = [{ id: "trial_call", when: { type: "judge", text: "Человек готов к созвону" }, to: "call" }, ...flow.states[0]!.exits];
    const messages = leadMagnetFlowChecks(flow).filter((issue) => /finish_dialog/.test(issue.message)).map((issue) => issue.message);
    expect(messages[0]).toMatch(/«Созвон».*без выходов.*конечная.*продолжается.*дай ей выход/s);
    expect(messages[1]).toMatch(/«Итог»/);
    expect(messages[1]).not.toMatch(/без выходов/);
  });

  it("finish_dialog и сроки в конечную ноду проверку проходят; переведённые лидмагниты — без находок", () => {
    const flow = yogaFlow();
    flow.states[0]!.exits = [
      { id: "trial_finish", when: FINISH, to: FINAL_STATE_ID },
      { id: "trial_timer", when: { type: "timer", from: "silence", amount: 3, unit: "d" }, to: FINAL_STATE_ID },
    ];
    expect(leadMagnetFlowChecks(flow).filter((issue) => /finish_dialog/.test(issue.message))).toEqual([]);
    expect(leadMagnetFlowChecks(leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS))).toEqual([]);
  });

  it("перевод старого черновика: выход словами в «Итог» становится событием finish_dialog, повтор — один", () => {
    const fixed = withFinishDialogEnds(yogaFlow());
    expect(exitsOf(fixed, "trial")).toEqual([{ id: "trial_done", when: FINISH, to: FINAL_STATE_ID }]);
    expect(leadMagnetFlowChecks(fixed)).toEqual([]);
  });

  it("единственный выход ноды словами в «Итог» — тоже finish_dialog: нода не становится конечной", () => {
    const flow = yogaFlow();
    flow.states[0]!.exits = [flow.states[0]!.exits[0]!];
    expect(exitsOf(withFinishDialogEnds(flow), "trial")).toEqual([{ id: "trial_done", when: FINISH, to: FINAL_STATE_ID }]);
  });

  it("правильный сценарий не меняется — тот же объект", () => {
    const flow = leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS);
    expect(withFinishDialogEnds(flow)).toBe(flow);
  });
});
