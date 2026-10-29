import type { AgentFlow, FlowAppChecks, FlowAppIssue, FlowExit, FlowNudges } from "@ykurilov/agent-chat-flows/format";
import { LEAD_MAGNET_TOOLS } from "./catalog";
import { endExitIssues } from "./end-exits";
import { PROGRAM_MAX_DAYS, PROGRAM_MIN_DAYS } from "./program-day-events";
import { SALE_TAG } from "./settings-to-flow";

export type { FlowAppChecks } from "@ykurilov/agent-chat-flows/format";

export { PROGRAM_MAX_DAYS, PROGRAM_MIN_DAYS } from "./program-day-events";
/** День программы начинается не раньше 5:00: раньше — ещё ночь. */
export const EARLIEST_DAY_START = "05:00";
/** Пределы касаний: ошибка в сценарии не должна заспамить людей. SDK верхних границ не держит. */
export const MAX_FIRST_MESSAGES_PER_DAY = 3;
/** Со дня 2 программы молчуну — не больше двух сообщений первым в день (решение Дмитрия 19.10). */
export const MAX_LATER_DAY_FIRST_MESSAGES = 2;
export const MAX_NUDGES_IN_ROW = 5;
/** Молчуну со второго дня — не больше двух сообщений в день (решение Дмитрия 19.10). */
export const MAX_DAILY_NUDGES = 2;
export const MIN_NUDGE_GAP_MINUTES = 10;

const quote = (text: string) => `«${text}»`;
const stateName = (flow: AgentFlow, index: number) => quote(flow.states[index]!.title.trim() || flow.states[index]!.id);

/** Подстановку «{имя}» в готовом тексте никто не заполнит: человек увидит её как есть. */
function placeholderIssue(text: string | undefined, path: string, where: string): FlowAppIssue[] {
  const placeholder = text?.match(/\{[^{}]*\}/)?.[0];
  return placeholder
    ? [{ path, message: `В ${where} есть ${quote(placeholder)}. Подстановки не заполняются: человек увидит её как есть` }]
    : [];
}

function saleIssues(flow: AgentFlow): FlowAppIssue[] {
  const issues: FlowAppIssue[] = [];
  const saleIndexes = flow.states.flatMap((state, index) => (state.tags.includes(SALE_TAG) ? [index] : []));
  for (const index of saleIndexes.slice(1))
    issues.push({ path: `states[${index}]`, message: `${stateName(flow, index)}: «Продажа» — только в одной ноде, она уже есть в ${stateName(flow, saleIndexes[0]!)}` });
  flow.states.forEach((state, index) => {
    const isSale = state.tags.includes(SALE_TAG);
    const hasAnswer = state.tools.includes(LEAD_MAGNET_TOOLS.saleAnswer);
    if (isSale && !hasAnswer)
      issues.push({ path: `states[${index}]`, message: `${stateName(flow, index)}: у ноды «Продажа» нужен инструмент ${LEAD_MAGNET_TOOLS.saleAnswer} — им агент записывает ответ на предложение` });
    if (!isSale && hasAnswer)
      issues.push({ path: `states[${index}]`, message: `${stateName(flow, index)}: ${LEAD_MAGNET_TOOLS.saleAnswer} — только в ноде «Продажа»` });
  });
  return issues;
}

function scheduleIssues(flow: AgentFlow): FlowAppIssue[] {
  const { schedule } = flow;
  if (!schedule) return [];
  const issues: FlowAppIssue[] = [];
  const days = schedule.lengthDays;
  if (days === undefined || days < PROGRAM_MIN_DAYS || days > PROGRAM_MAX_DAYS)
    issues.push({ path: "schedule.lengthDays", message: `«Дни и время»: срок воронки — от ${PROGRAM_MIN_DAYS} до ${PROGRAM_MAX_DAYS} дней` });
  // Время уже проверено разбором как «ЧЧ:ММ»: строки сравниваются как время
  if (schedule.dayStart < EARLIEST_DAY_START)
    issues.push({ path: "schedule.dayStart", message: "«Дни и время»: день начинается не раньше 5:00 — раньше ещё ночь" });
  issues.push(...placeholderIssue(schedule.farewellText, "schedule.farewellText", "прощании при «срок вышел»"));
  issues.push(...placeholderIssue(schedule.dayFrame?.hardText, "schedule.dayFrame.hardText", "фразе жёсткой рамки дня"));
  return issues;
}

const UNIT_MINUTES = { min: 1, h: 60, d: 24 * 60 } as const;
const clockMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** Касания одного места: `where` — начало текста ошибки («Нода», «Дни и время»), `path` — путь к касаниям. */
function nudgesIssues(nudges: FlowNudges | "off" | undefined, path: string, where: string): FlowAppIssue[] {
  if (!nudges || nudges === "off") return [];
  const issues: FlowAppIssue[] = [];
  if (nudges.afterSilence.length > MAX_NUDGES_IN_ROW)
    issues.push({ path: `${path}.afterSilence`, message: `${where}: касаний после тишины — не больше ${MAX_NUDGES_IN_ROW} подряд` });
  nudges.afterSilence.forEach((step, index) => {
    if (step.amount * UNIT_MINUTES[step.unit] < MIN_NUDGE_GAP_MINUTES)
      issues.push({ path: `${path}.afterSilence[${index}]`, message: `${where}: касание после тишины — не чаще раза в ${MIN_NUDGE_GAP_MINUTES} минут` });
  });
  const daily = [...(nudges.dailyAt ?? [])].map(clockMinutes).sort((a, b) => a - b);
  if (daily.length > MAX_DAILY_NUDGES)
    issues.push({ path: `${path}.dailyAt`, message: `${where}: касаний по часам — не больше ${MAX_DAILY_NUDGES} в день` });
  // Соседние по кругу суток: 23:55 и 00:00 тоже рядом
  const tooClose = daily.some((at, index) => index > 0 && at - daily[index - 1]! < MIN_NUDGE_GAP_MINUTES) ||
    (daily.length > 1 && daily[0]! + 24 * 60 - daily[daily.length - 1]! < MIN_NUDGE_GAP_MINUTES);
  if (tooClose)
    issues.push({ path: `${path}.dailyAt`, message: `${where}: касания по часам — не ближе ${MIN_NUDGE_GAP_MINUTES} минут друг к другу` });
  return issues;
}

function touchLimitIssues(flow: AgentFlow): FlowAppIssue[] {
  const issues: FlowAppIssue[] = [];
  const maxPerDay = flow.schedule?.firstMessages?.maxPerDay;
  if (maxPerDay !== undefined && maxPerDay > MAX_FIRST_MESSAGES_PER_DAY)
    issues.push({
      path: "schedule.firstMessages.maxPerDay",
      message: `«Дни и время»: сообщений первым — не больше ${MAX_FIRST_MESSAGES_PER_DAY} в день`,
    });
  flow.schedule?.firstMessages?.maxPerDayByDay?.forEach((cap, index) => {
    const limit = index === 0 ? MAX_FIRST_MESSAGES_PER_DAY : MAX_LATER_DAY_FIRST_MESSAGES;
    if (cap > limit)
      issues.push({
        path: `schedule.firstMessages.maxPerDayByDay[${index}]`,
        message: `«Дни и время»: сообщений первым ${index === 0 ? "в день 1" : "со дня 2"} — не больше ${limit} в день`,
      });
  });
  issues.push(...nudgesIssues(flow.nudges, "nudges", "Касания сценария"));
  issues.push(...nudgesIssues(flow.schedule?.nudges, "schedule.nudges", "«Дни и время»"));
  flow.states.forEach((state, index) => issues.push(...nudgesIssues(state.nudges, `states[${index}].nudges`, stateName(flow, index))));
  if (flow.schedule)
    flow.states.forEach((state, index) => {
      if (state.nudges && state.nudges !== "off" && state.nudges.days !== undefined && state.nudges.untilProgramDay === undefined)
        issues.push({
          level: "warning",
          path: `states[${index}].nudges`,
          message: `${stateName(flow, index)}: частые касания ноды без «до дня воронки» повторятся в любой день, когда человек придёт в ноду. У ноды первого дня поставьте «до дня воронки включительно» 1 (untilProgramDay: 1)`,
        });
    });
  return issues;
}

function startIssues(flow: AgentFlow): FlowAppIssue[] {
  const index = flow.states.findIndex((state) => state.id === flow.start);
  if (index === -1 || flow.states[index]!.firstMessage === null) return [];
  return [
    {
      path: `states[${index}].firstMessage`,
      message: `${stateName(flow, index)}: у стартовой ноды нет своего первого сообщения — первое сообщение лидмагнита задаётся в «Настройках»`,
    },
  ];
}

function sideTaskIssues(flow: AgentFlow): FlowAppIssue[] {
  const card = new Set(flow.clientCard.map((field) => field.id));
  return (flow.sideTasks ?? []).flatMap((task, index) =>
    // Поля нет нигде — находка SDK; здесь — поле из заметок чата: в «Базу» оно не попадёт
    task.field !== undefined && !card.has(task.field) && flow.chatNotes.some((note) => note.id === task.field)
      ? [{ path: `sideTasks[${index}].field`, message: `Попутная задача ${quote(task.text)}: поле ответа — из карточки клиента, тогда ответ попадёт в «Базу»` }]
      : [],
  );
}

const isResultExit = (exit: FlowExit) => exit.when.type === "judge" || exit.when.type === "data";
const isTimeExit = (exit: FlowExit) => exit.when.type === "timer";

/**
 * Выход по времени в ноду, куда дальше по сценарию приходят по результату: не успевший попадёт туда без результата
 * (старый автоперенос: «Идея» длится 1 день → «Доработка» несуществующего приложения). Пусть продолжает с того же
 * места; срок по дню — только в «Продажу». Предупреждение: эксперт мог так задумать.
 */
function timeIntoResultIssues(flow: AgentFlow): FlowAppIssue[] {
  const byId = new Map(flow.states.map((state) => [state.id, state]));
  /** Нода, из которой по результату приходят в `target`, если она достижима из `from` по результатам; нет — `null`. */
  function resultSource(from: string, target: string): string | null {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const exit of byId.get(id)?.exits ?? []) {
        if (!isResultExit(exit) || exit.to === null) continue;
        if (exit.to === target) return id;
        if (!seen.has(exit.to)) {
          seen.add(exit.to);
          queue.push(exit.to);
        }
      }
    }
    return null;
  }
  const issues: FlowAppIssue[] = [];
  flow.states.forEach((state, index) =>
    state.exits.forEach((exit, exitIndex) => {
      const target = exit.to === null ? undefined : byId.get(exit.to);
      if (!isTimeExit(exit) || !target || target.tags.includes(SALE_TAG)) return;
      const source = resultSource(state.id, target.id);
      if (source === null) return;
      const targetName = stateName(flow, flow.states.indexOf(target));
      const after = source === state.id ? "этой ноды" : stateName(flow, flow.states.findIndex((item) => item.id === source));
      issues.push({
        level: "warning",
        path: `states[${index}].exits[${exitIndex}]`,
        message:
          `${stateName(flow, index)}: выход по времени ведёт в ${targetName}, а туда приходят по результату ${after}. ` +
          "Не успевший попадёт туда без результата — лучше пусть утром продолжит с того же места; срок по дню — только в «Продажу»",
      });
    }),
  );
  return issues;
}

function afterEndIssues(flow: AgentFlow): FlowAppIssue[] {
  return flow.afterEnd === "silent"
    ? []
    : [{ path: "afterEnd", message: "После конца разговора агент молчит (`silent`): новые сообщения идут эксперту во «Входящие»" }];
}

/**
 * Проверки лидмагнита поверх проверок SDK (plan.md, раздел 4). Одна функция для доски (`checks` у `FlowEditor`) и
 * сервера (`checkFlow(flow, catalog, { checks })`). Мягкую рамку раньше жёсткой и ночь после начала дня проверяет SDK.
 */
export const leadMagnetFlowChecks: FlowAppChecks = (flow) => [
  ...saleIssues(flow),
  ...endExitIssues(flow),
  ...scheduleIssues(flow),
  ...startIssues(flow),
  ...sideTaskIssues(flow),
  ...afterEndIssues(flow),
  ...touchLimitIssues(flow),
  ...timeIntoResultIssues(flow),
];
