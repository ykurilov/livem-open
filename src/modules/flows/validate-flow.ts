import { checkFlow, parseFlow, type AgentFlow, type FlowIssue } from "@ykurilov/agent-chat-flows/format";
import { leadMagnetFlowChecks } from "./app-checks";
import { leadMagnetFlowCatalog } from "./catalog";

/** Ошибка сценария: путь внутри JSON сценария (`states[2].exits[0].when.text`; пусто — весь сценарий) и текст. */
export interface FlowSettingsIssue {
  path: string;
  message: string;
}

export type FlowValidation = { ok: true; flow: AgentFlow } | { ok: false; issues: FlowSettingsIssue[] };

/** Находки SDK про «Дни и время» приходят без места: путь — к блоку целиком. */
const SCHEDULE_CODES = new Set(["night_before_day_start", "day_frame_soft_after_hard", "unknown_deadline_state"]);

function indexPath(list: readonly { id: string }[] | undefined, id: string | undefined, key: string): string | null {
  if (!list || id === undefined) return null;
  const index = list.findIndex((item) => item.id === id);
  return index === -1 ? null : `${key}[${index}]`;
}

/** Путь находки `checkFlow` в JSON сценария — по её месту. */
export function flowIssuePath(flow: AgentFlow, issue: FlowIssue): string {
  if (SCHEDULE_CODES.has(issue.code)) return "schedule";
  const { stateId, exitId, fieldId, sideTaskId } = issue.place;
  const state = indexPath(flow.states, stateId, "states");
  if (state) {
    const exit = indexPath(flow.states.find((item) => item.id === stateId)!.exits, exitId, "exits");
    return exit ? `${state}.${exit}` : state;
  }
  return (
    indexPath(flow.anyState.exits, exitId, "anyState.exits") ??
    indexPath(flow.sideTasks, sideTaskId, "sideTasks") ??
    indexPath(flow.clientCard, fieldId, "clientCard") ??
    indexPath(flow.chatNotes, fieldId, "chatNotes") ??
    ""
  );
}

/** Находка в сценарии: ошибка не даёт сохранить, замечание — подсказка автору. */
export interface FlowSettingsFinding extends FlowSettingsIssue {
  level: "error" | "warning";
}

/** Все находки SDK и наших проверок с уровнем и путём: конструктор видит и замечания. */
export function leadMagnetFlowIssues(flow: AgentFlow): FlowSettingsFinding[] {
  // Наши находки — со своим путём: `checkFlow(…, { checks })` свёл бы его к месту на доске
  return [
    ...checkFlow(flow, leadMagnetFlowCatalog()).map((issue) => ({ level: issue.level, path: flowIssuePath(flow, issue), message: issue.message })),
    ...leadMagnetFlowChecks(flow).map((issue) => ({ level: issue.level ?? ("error" as const), path: issue.path ?? "", message: issue.message })),
  ];
}

/**
 * Проверка сценария лидмагнита при любом сохранении (черновик, конструктор, доска, `lm.sh`, публикация): разбор формы,
 * связи SDK и наши проверки. Замечания SDK (`warning`) сохранению не мешают.
 */
export function validateLeadMagnetFlow(input: unknown): FlowValidation {
  const parsed = parseFlow(input);
  if (!parsed.ok) return { ok: false, issues: parsed.errors.map(({ path, message }) => ({ path, message })) };
  const { flow } = parsed;
  const issues = leadMagnetFlowIssues(flow)
    .filter((issue) => issue.level === "error")
    .map(({ path, message }) => ({ path, message }));
  return issues.length === 0 ? { ok: true, flow } : { ok: false, issues };
}
