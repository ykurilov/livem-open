import { randomUUID } from "node:crypto";
import { AGENT_FLOW_FORMAT, AGENT_FLOW_FORMAT_VERSION, type AgentFlow } from "@ykurilov/agent-chat-flows/format";
import type { LeadMagnetSettings } from "../lead-magnets/settings";
import type { FieldDefinition } from "../people";
import { LEAD_MAGNET_TOOLS, clientCardFieldOf } from "./catalog";
import { PROGRAM_FIRST_MESSAGES_BY_DAY, PROGRAM_NUDGES } from "./settings-to-flow";

const TOOL_ORDER: readonly string[] = Object.values(LEAD_MAGNET_TOOLS);

/** Инструменты сценария — те, что стоят у нод: инструмент ноды, которого нет в списке сценария, SDK не пустит. */
export function withStateTools(flow: AgentFlow): AgentFlow {
  const used = new Set(flow.states.flatMap((state) => state.tools));
  const tools = [...TOOL_ORDER.filter((tool) => used.has(tool)), ...[...used].filter((tool) => !TOOL_ORDER.includes(tool))];
  return { ...flow, tools };
}

/**
 * Настройки с новым сценарием. Основная инструкция, поля и просмотр ссылок повторяют сценарий: их ещё читают движок хода
 * до переноса на сценарии и откат на старую версию. Этапы и программа не трогаются.
 */
export function withLeadMagnetFlow(settings: LeadMagnetSettings, flow: AgentFlow): LeadMagnetSettings {
  const next = withStateTools(flow);
  return {
    ...settings,
    flow: next,
    instruction: next.common,
    fieldIds: next.clientCard.map((field) => field.id),
    viewsLinks: next.states.some((state) => state.tools.includes(LEAD_MAGNET_TOOLS.personLinkView)),
  };
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * «Дни и время» с умолчаниями программы: касания (без них программа брала бы частые касания сценария «15 мин, 1 ч» заново
 * каждое утро) и потолок по дням программы. Заданное не перекрывается.
 */
export function scheduleWithDefaults(schedule: unknown): unknown {
  if (!isObject(schedule)) return schedule;
  const firstMessages = isObject(schedule.firstMessages) ? schedule.firstMessages : {};
  return {
    ...schedule,
    nudges: schedule.nudges ?? PROGRAM_NUDGES,
    firstMessages: { ...firstMessages, maxPerDayByDay: firstMessages.maxPerDayByDay ?? PROGRAM_FIRST_MESSAGES_BY_DAY },
  };
}

/**
 * JSON сценария от конструктора или агента, дополненный тем, что они не обязаны знать: формат, id и имя сценария, общее
 * (это основная инструкция), режим после конца, раскладку доски, id попутных задач, касания и потолок программы. Поле карточки можно назвать одним id.
 */
export function completeFlowJson(json: Json, current: AgentFlow): Json {
  const sideTasks = Array.isArray(json.sideTasks)
    ? json.sideTasks.map((task) => (typeof task === "object" && task !== null && !("id" in task) ? { id: randomUUID(), ...task } : task))
    : json.sideTasks;
  const clientCard = Array.isArray(json.clientCard)
    ? json.clientCard.map((field) => (typeof field === "string" ? { id: field, name: field, about: "" } : field))
    : json.clientCard;
  return {
    format: AGENT_FLOW_FORMAT,
    version: AGENT_FLOW_FORMAT_VERSION,
    id: current.id,
    name: current.name,
    common: current.common,
    afterEnd: "silent",
    layout: current.layout,
    ...json,
    ...(clientCard !== undefined && { clientCard }),
    ...(sideTasks !== undefined && { sideTasks }),
    ...(json.schedule !== undefined && { schedule: scheduleWithDefaults(json.schedule) }),
  };
}

/** Карточка клиента по словарю «Базы»: название, описание, тип и варианты — из словаря. Поля нет — его id в `missing`. */
export function cardFromDictionary(
  flow: AgentFlow,
  dictionary: readonly FieldDefinition[],
): { ok: true; flow: AgentFlow } | { ok: false; missing: string[] } {
  const byId = new Map(dictionary.map((field) => [field.id, field]));
  const missing = flow.clientCard.filter((field) => !byId.has(field.id)).map((field) => field.id);
  if (missing.length > 0) return { ok: false, missing };
  const clientCard = flow.clientCard.map((field) => ({ ...clientCardFieldOf(byId.get(field.id)!), refreshAfterMonths: field.refreshAfterMonths }));
  return { ok: true, flow: { ...flow, clientCard } };
}
