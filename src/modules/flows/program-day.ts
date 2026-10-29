import type { AgentFlow, FlowExit } from "@ykurilov/agent-chat-flows/format";
import { withFinishDialogEnds } from "./end-exits";
import { PROGRAM_MAX_DAYS, legacyProgramDayOfEvent } from "./program-day-events";
import { SALE_TAG } from "./settings-to-flow";

// «Продажа» — на свой день программы или раньше по условию словами (решение Дмитрия 14.10). Срок в неё — таймер SDK
// «наступил день N программы»: переход в начале дня, даже если человек молчит.

/**
 * День, к которому человек доходит до ноды, если только ждёт сроков: самый длинный путь от старта, где срок «нода длится
 * N дней» прибавляет N дней, а остальные выходы — ни одного. Круги не раскручиваются: день не больше срока программы.
 */
function plannedDays(flow: AgentFlow): Map<string, number> {
  const cap = flow.schedule?.lengthDays ?? PROGRAM_MAX_DAYS;
  const days = new Map<string, number>(flow.start === null ? [] : [[flow.start, 1]]);
  for (let round = 0; round < flow.states.length; round += 1) {
    let changed = false;
    for (const state of flow.states) {
      const from = days.get(state.id);
      if (from === undefined) continue;
      for (const exit of state.exits) {
        if (exit.to === null || !flow.states.some((target) => target.id === exit.to)) continue;
        const day = Math.min(cap, from + (exit.when.type === "timer" && exit.when.from === "state_days" ? exit.when.days : 0));
        if (day > (days.get(exit.to) ?? 0)) {
          days.set(exit.to, day);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return days;
}

const isDayTimer = (exit: FlowExit) => exit.when.type === "timer" && exit.when.from === "state_days";

/**
 * Сценарий, где срок в «Продажу» — день программы: «нода длится N дней» перед «Продажей» пускал в неё на день
 * раньше того, кто вошёл в ноду раньше срока. День — тот, к которому туда приходит молчун. Нечего менять — тот же объект.
 */
export function withProgramDaySale(flow: AgentFlow): AgentFlow {
  if (!flow.schedule) return flow;
  const sale = new Set(flow.states.filter((state) => state.tags.includes(SALE_TAG)).map((state) => state.id));
  const leadsToSale = (exit: FlowExit) => isDayTimer(exit) && exit.to !== null && sale.has(exit.to);
  if (!flow.states.some((state) => state.exits.some(leadsToSale))) return flow;
  const days = plannedDays(flow);
  return {
    ...flow,
    states: flow.states.map((state) => {
      if (!state.exits.some(leadsToSale)) return state;
      const from = days.get(state.id) ?? 1;
      return {
        ...state,
        exits: state.exits.map((exit) =>
          leadsToSale(exit) && exit.when.type === "timer" && exit.when.from === "state_days"
            ? { ...exit, when: { type: "timer", from: "program_day", day: from + exit.when.days } }
            : exit,
        ),
      };
    }),
  };
}

/** Старое событие дня `program_day_N` (до SDK 0.55) — таймер «наступил день N программы». */
function programDayTimerOf(exit: FlowExit): FlowExit {
  if (exit.when.type !== "event" || exit.when.event !== "app") return exit;
  const day = legacyProgramDayOfEvent(exit.when.name);
  return day === null ? exit : { ...exit, when: { type: "timer", from: "program_day", day } };
}

/** Сценарий, где срок в «Продажу» ещё событие `program_day_N`, — с таймером дня программы. Нечего менять — тот же объект. */
export function withProgramDayTimers(flow: AgentFlow): AgentFlow {
  const withTimers = (exits: FlowExit[]) => (exits.some((exit) => programDayTimerOf(exit) !== exit) ? exits.map(programDayTimerOf) : exits);
  const states = flow.states.map((state) => {
    const exits = withTimers(state.exits);
    return exits === state.exits ? state : { ...state, exits };
  });
  const anyExits = withTimers(flow.anyState.exits);
  if (anyExits === flow.anyState.exits && states.every((state, index) => state === flow.states[index])) return flow;
  return { ...flow, states, anyState: { ...flow.anyState, exits: anyExits } };
}

/**
 * Сценарий, сохранённый до правил 14.10, — по нынешним: конец разговора только через finish_dialog, срок в «Продажу» —
 * таймер дня программы. Для загрузки чата и перевода черновиков; правильный сценарий — тот же объект.
 */
export const withCurrentFlowRules = (flow: AgentFlow): AgentFlow => withProgramDayTimers(withProgramDaySale(withFinishDialogEnds(flow)));
