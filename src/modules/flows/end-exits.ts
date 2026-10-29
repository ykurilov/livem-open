import type { AgentFlow, FlowAppIssue, FlowCondition, FlowExit } from "@ykurilov/agent-chat-flows/format";
import { LEAD_MAGNET_TOOLS } from "./catalog";
import { FINAL_STATE_ID } from "./settings-to-flow";

// Конец разговора — только через finish_dialog (eval 14.10): он записывает итог и исход, шлёт прощание. Переход в
// «Итог» по условию словами закрывал разговор без них, и человеку уходило «Разговор завершён.».

const FINISH_DIALOG_EVENT: FlowCondition = { type: "event", event: "tool", name: LEAD_MAGNET_TOOLS.finishDialog };

/** Конечные ноды — без выходов («Итог», «Срок вышел»): вход в такую закрывает разговор. */
function endStateIds(flow: AgentFlow): Set<string> {
  return new Set(flow.states.filter((state) => state.exits.length === 0).map((state) => state.id));
}

/** Каким выходом в конечную ноду разговор вправе закончиться: событием finish_dialog или по сроку. */
function endsProperly(exit: FlowExit): boolean {
  const { when } = exit;
  return when.type === "timer" || (when.type === "event" && when.event === "tool" && when.name === LEAD_MAGNET_TOOLS.finishDialog);
}

const isBadEnd = (exit: FlowExit, ends: ReadonlySet<string>) => exit.to !== null && ends.has(exit.to) && !endsProperly(exit);

/** Выходы, которыми разговор закончился бы мимо finish_dialog: для доски, конструктора и сохранения. */
export function endExitIssues(flow: AgentFlow): FlowAppIssue[] {
  const ends = endStateIds(flow);
  const titleOf = (id: string) => flow.states.find((state) => state.id === id)!.title.trim() || id;
  // Рабочая нода, которой забыли дать выход, — тоже конечная (eval 19.10: «Созвон»): подсказка, как это исправить
  const intendedEnds = new Set([FINAL_STATE_ID, flow.schedule?.deadlineState]);
  const issue = (path: string, from: string, exit: FlowExit): FlowAppIssue => ({
    path,
    message:
      `${from} → «${titleOf(exit.to!)}»: в конечную ноду разговор попадает только по событию ${LEAD_MAGNET_TOOLS.finishDialog} ` +
      "(или по сроку) — так человек получает итог и прощание. Условие словами оставьте в инструкции ноды" +
      (intendedEnds.has(exit.to!)
        ? ""
        : `. «${titleOf(exit.to!)}» — без выходов, поэтому конечная: если разговор в ней продолжается, дай ей выход, например в «Итог» по ${LEAD_MAGNET_TOOLS.finishDialog}`),
  });
  return [
    ...flow.states.flatMap((state, index) =>
      state.exits.flatMap((exit, at) => (isBadEnd(exit, ends) ? [issue(`states[${index}].exits[${at}]`, `«${state.title.trim() || state.id}»`, exit)] : [])),
    ),
    ...flow.anyState.exits.flatMap((exit, at) => (isBadEnd(exit, ends) ? [issue(`anyState.exits[${at}]`, "«Из любого состояния»", exit)] : [])),
  ];
}

/** Выходы с плохими концами — на событие finish_dialog (id тот же: на него ссылается история); повтор того же выхода убран. */
function fixedExits(exits: FlowExit[], ends: ReadonlySet<string>): FlowExit[] {
  if (!exits.some((exit) => isBadEnd(exit, ends))) return exits;
  const fixed = exits.map((exit) => (isBadEnd(exit, ends) ? { ...exit, when: FINISH_DIALOG_EVENT } : exit));
  return fixed.filter((exit, index) => fixed.findIndex((other) => other.to === exit.to && JSON.stringify(other.when) === JSON.stringify(exit.when)) === index);
}

/**
 * Сценарий, где конец разговора — только finish_dialog или срок: для черновиков и снимков, сохранённых до этой
 * проверки. Правильный сценарий возвращается тем же объектом.
 */
export function withFinishDialogEnds(flow: AgentFlow): AgentFlow {
  if (endExitIssues(flow).length === 0) return flow;
  const ends = endStateIds(flow);
  return {
    ...flow,
    states: flow.states.map((state) => ({ ...state, exits: fixedExits(state.exits, ends) })),
    anyState: { ...flow.anyState, exits: fixedExits(flow.anyState.exits, ends) },
  };
}
