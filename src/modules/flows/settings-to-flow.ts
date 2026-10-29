import {
  AGENT_FLOW_FORMAT,
  AGENT_FLOW_FORMAT_VERSION,
  DEFAULT_LATE_START_HOURS,
  DEFAULT_SIDE_QUESTION_EVERY_MESSAGES,
  DEFAULT_SIDE_TASK_MAX_ATTEMPTS,
  type AgentFlow,
  type FlowExit,
  type FlowNudges,
  type FlowSchedule,
  type FlowSideTask,
  type FlowState,
  type FlowStateNudges,
} from "@ykurilov/agent-chat-flows/format";
import type { LeadMagnetSettings, ProgramSettings, Stage } from "../lead-magnets/settings";
import type { FieldDefinition } from "../people";
import { LEAD_MAGNET_TOOLS, clientCardFieldOf } from "./catalog";

/** Поле `id` внутри JSON сценария. При запуске сценарий зовётся id лидмагнита, а версия — id снимка. */
export const LEAD_MAGNET_FLOW_ID = "lead-magnet";

/** Нода лидмагнита без этапов. */
export const CONVERSATION_STATE_ID = "conversation";
/** Конечная нода «Итог»: в неё ведёт finish_dialog из любой ноды. */
export const FINAL_STATE_ID = "final";
/** Конечная нода «Срок вышел» программы: в неё ведёт только `schedule.deadlineState` (с SDK 0.51 она достижима). */
export const DEADLINE_STATE_ID = "deadline";
/** Метка ноды «Продажа»: по ней отчёт считает «дошли до продажи», а сценарий пускает `sale_answer`. */
export const SALE_TAG = "продажа";

/** Начало дня программы, оно же утреннее сообщение (решение Дмитрия 14.10). */
export const PROGRAM_DAY_START = "09:00";
/** Пришёл позже, чем за столько часов до ночи, — первый день программы завтра. */
export const LATE_START_HOURS = DEFAULT_LATE_START_HOURS;
/** Ответил эксперт — агент молчит столько часов тишины эксперта: `createAgentFlow({ pause: { staffSilenceHours } })`. */
export const STAFF_SILENCE_HOURS = 2;
/** Фраза жёсткой рамки дня: уходит без модели, один раз за день. */
export const HARD_DAY_FRAME_TEXT = "Утром отвечу!";

/** Напоминания бросившим у лидмагнита без программы: 15 минут, час, потом утром и вечером; 3 дня тишины — «не завершил». */
export const CONVERSATION_NUDGES: FlowNudges = {
  afterSilence: [
    { amount: 15, unit: "min" },
    { amount: 1, unit: "h" },
  ],
  dailyAt: ["10:00", "19:00"],
  giveUpAfter: { amount: 3, unit: "d" },
};

/** Общие касания программы: после утреннего — через 3 ч и ещё через 3 ч. Частые касания дня 1 — у нод первого дня. */
export const PROGRAM_NUDGES: FlowNudges = {
  afterSilence: [
    { amount: 3, unit: "h" },
    { amount: 3, unit: "h" },
  ],
};
/** Сообщений первым по дням программы: в день 1 — три, со дня 2 — два (решение Дмитрия 19.10). Ответ человека счёт не обнуляет. */
export const PROGRAM_FIRST_MESSAGES_BY_DAY = [3, 2];
/** Ниже потолок со дня 2 не поднять: молчуну — не больше двух сообщений в день. */
const LATER_DAYS_FIRST_MESSAGES = PROGRAM_FIRST_MESSAGES_BY_DAY[1]!;

/** Старые части настроек, из которых строится сценарий: этапы, программа, поля, просмотр ссылок. */
export type LeadMagnetFlowSource = Pick<LeadMagnetSettings, "name" | "instruction" | "stages" | "program" | "fieldIds" | "viewsLinks">;

function finishExit(id: string): FlowExit {
  return { id, when: { type: "event", event: "tool", name: LEAD_MAGNET_TOOLS.finishDialog }, to: FINAL_STATE_ID };
}

function endState(id: string, title: string, instructions: string): FlowState {
  return { id, kind: "state", title, instructions, firstMessage: null, learn: [], noSideQuestions: true, tools: [], tags: [], exits: [] };
}

/** Плановый день этапа: наибольший день начала среди этапов до него включительно; нет ни одного — день 1. */
function plannedDays(stages: readonly Stage[]): number[] {
  let day = 1;
  return stages.map((stage) => (day = Math.max(day, stage.startDay ?? 1)));
}

interface WorkingNode {
  id: string;
  title: string;
  instructions: string;
  /** Условие словами в следующую ноду; `null` — выхода словами нет. */
  judge: { text: string; to: string } | null;
  /**
   * Срок в «Продажу» — таймер «наступил день `day` программы». Других сроков между нодами нет: ноды «дня N» достижимы по
   * результату предыдущей, а не успевший утром продолжает с того же места (решение Дмитрия 14.10). «Нода длится N дней»
   * пустил бы в «Доработку» того, кто приложение ещё не собрал.
   */
  saleDay: { day: number; to: string } | null;
  plannedDay: number;
  isSale: boolean;
}

function stageNodes(stages: readonly Stage[]): WorkingNode[] {
  const planned = plannedDays(stages);
  return stages.map((stage, index) => {
    const next = stages[index + 1];
    const condition = stage.transitionCondition.trim();
    const sale = stages.find((later, laterAt) => laterAt > index && later.isSale && (later.startDay ?? 0) > planned[index]!);
    const instruction = stage.instruction.trim();
    return {
      id: stage.id,
      title: stage.name,
      instructions: instruction ? `${stage.name}\n${instruction}` : stage.name,
      // Пустое условие в середине: раньше консультант переходил сам по цели этапа — теперь это условие судьи
      judge: next ? { text: condition || `Цель этапа «${stage.name}» достигнута`, to: next.id } : null,
      saleDay: sale ? { day: sale.startDay!, to: sale.id } : null,
      plannedDay: planned[index]!,
      isSale: stage.isSale,
    };
  });
}

const CONVERSATION_NODE: WorkingNode = {
  id: CONVERSATION_STATE_ID,
  title: "Разговор",
  instructions: "Провести разговор по общей инструкции",
  judge: null,
  saleDay: null,
  plannedDay: 1,
  isSale: false,
};

/**
 * Частые касания нод первого дня — только в день входа и только в день 1 программы: со следующего дня и у пришедшего в
 * ноду позже — общий ряд «Дней и времени» от утреннего.
 */
function firstDayNudges(program: ProgramSettings): FlowStateNudges {
  return { afterSilence: program.outreach.firstDayAfterSilenceMinutes.map((amount) => ({ amount, unit: "min" })), days: 1, untilProgramDay: 1 };
}

function workingState(node: WorkingNode, isLast: boolean, input: { program: ProgramSettings | null; viewsLinks: boolean }): FlowState {
  const exits: FlowExit[] = [];
  if (node.judge) exits.push({ id: `${node.id}_done`, when: { type: "judge", text: node.judge.text }, to: node.judge.to });
  if (node.saleDay)
    exits.push({ id: `${node.id}_days`, when: { type: "timer", from: "program_day", day: node.saleDay.day }, to: node.saleDay.to });
  // Нода без выходов для SDK конечная: вход в неё закрыл бы разговор. Последней — свой выход в «Итог»
  if (isLast) exits.push(finishExit(`${node.id}_finish`));
  const tools: string[] = [];
  if (node.isSale) tools.push(LEAD_MAGNET_TOOLS.saleAnswer);
  if (input.viewsLinks) tools.push(LEAD_MAGNET_TOOLS.personLinkView);
  return {
    id: node.id,
    kind: "state",
    title: node.title,
    instructions: node.instructions,
    firstMessage: null,
    learn: [],
    noSideQuestions: false,
    tools,
    tags: node.isSale ? [SALE_TAG] : [],
    exits,
    ...(input.program && node.plannedDay === 1 ? { nudges: firstDayNudges(input.program) } : {}),
  };
}

function programSchedule(program: ProgramSettings): FlowSchedule {
  return {
    dayStart: PROGRAM_DAY_START,
    nightFrom: program.outreach.latestAt,
    lateStartHours: LATE_START_HOURS,
    lengthDays: program.days,
    deadlineState: DEADLINE_STATE_ID,
    // Прощание при «срок вышел» — настройка сценария, по умолчанию выключена (решение Дмитрия 14.10)
    farewellOnDeadline: false,
    firstMessages: {
      maxPerDay: program.outreach.maxPerDay,
      maxPerDayByDay: [program.outreach.maxPerDay, Math.min(program.outreach.maxPerDay, LATER_DAYS_FIRST_MESSAGES)],
    },
    nudges: { afterSilence: program.outreach.afterSilenceHours.map((amount) => ({ amount, unit: "h" })) },
    dayFrame: { softFrom: program.softDailyMessages, hardAt: program.hardDailyMessages, hardText: HARD_DAY_FRAME_TEXT },
  };
}

function sideTasksOf(program: ProgramSettings, cardFieldIds: ReadonlySet<string>): FlowSideTask[] {
  return program.sideTasks.map((task) => ({
    id: task.id,
    text: task.task,
    ...(task.when.trim() ? { when: task.when } : {}),
    ...(task.fieldId && cardFieldIds.has(task.fieldId) ? { field: task.fieldId } : {}),
    maxAttempts: DEFAULT_SIDE_TASK_MAX_ATTEMPTS,
    perConversation: false,
  }));
}

/**
 * Сценарий SDK из старых настроек лидмагнита (plan.md, раздел 3.1). Чистая функция: миграция, `lm.sh` и конструктор
 * переводят ею одинаково. `fields` — словарь «Базы»: поля лидмагнита, которых в нём нет, пропускаются.
 */
export function leadMagnetToFlow(settings: LeadMagnetFlowSource, fields: readonly FieldDefinition[]): AgentFlow {
  const { program } = settings;
  const nodes = settings.stages.length > 0 ? stageNodes(settings.stages) : [CONVERSATION_NODE];
  const states = nodes.map((node, index) => workingState(node, index === nodes.length - 1, { program, viewsLinks: settings.viewsLinks }));
  states.push(endState(FINAL_STATE_ID, "Итог", "Разговор закончен\nКоротко попрощайся по правилам прощания. Не веди по шагам и не продавай заново."));
  if (program)
    states.push(
      endState(DEADLINE_STATE_ID, "Срок вышел", "Программа закончилась по сроку\nКоротко подведи итог и скажи, что дальше ответит эксперт лично. Не веди по шагам и не продавай заново."),
    );

  const byId = new Map(fields.map((field) => [field.id, field]));
  const clientCard = settings.fieldIds.flatMap((id) => {
    const field = byId.get(id);
    return field ? [clientCardFieldOf(field)] : [];
  });
  const tools = [LEAD_MAGNET_TOOLS.saleAnswer, LEAD_MAGNET_TOOLS.personLinkView].filter((tool) =>
    states.some((state) => state.tools.includes(tool)),
  );

  return {
    format: AGENT_FLOW_FORMAT,
    version: AGENT_FLOW_FORMAT_VERSION,
    id: LEAD_MAGNET_FLOW_ID,
    name: settings.name,
    start: nodes[0]!.id,
    common: settings.instruction,
    pace: { sideQuestionEveryMessages: DEFAULT_SIDE_QUESTION_EVERY_MESSAGES },
    clientCard,
    chatNotes: [],
    tools,
    anyState: { except: [], exits: [finishExit(LEAD_MAGNET_TOOLS.finishDialog)] },
    states,
    layout: {},
    ...(program
      ? { schedule: programSchedule(program), sideTasks: sideTasksOf(program, new Set(clientCard.map((field) => field.id))) }
      : { nudges: CONVERSATION_NUDGES }),
    afterEnd: "silent",
  };
}
