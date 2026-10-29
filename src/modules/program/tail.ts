import type { PassageSideTasks, SaleAnswer, SaleReason } from "../consultant/schema";
import type { LeadMagnetSettings } from "../lead-magnets/settings";
import { DEFAULT_TIME_ZONE, localTime } from "./calendar";
import type { DayLimitState } from "./day-limits";
import { openSideTasks } from "./side-tasks";

export interface ProgramTailInput {
  /** Настройки снимка с программой. */
  settings: LeadMagnetSettings;
  day: number;
  now: Date;
  /** Пояс человека; `null` — неизвестен, считаем по Москве. */
  timeZone: string | null;
  currentStageId: string | null;
  /** В этом ходе приложение само перевело на этап по дню программы. */
  stageChangedByDay: boolean;
  dayLimit: DayLimitState;
  /** Сообщений человека за день программы, включая те, на которые сейчас отвечают. */
  messagesToday: number;
  saleAnswer: SaleAnswer | null;
  sideTasks: PassageSideTasks;
  /** Сообщений человека за всю программу: от него пауза между попутными задачами. */
  personMessageCount: number;
  /** В ходе есть сообщения, которые человек прислал вчера после рамки дня. */
  backlogFromYesterday: boolean;
  /** Ход «писать первым»: утреннее сообщение нового дня или сообщение при молчании. */
  outreach?: "morning" | "silence";
  /** На прошлое предложение продукта в сообщении первым человек не ответил: в этом не предлагать (`saleOfferPaused`). */
  saleOfferPaused?: boolean;
}

const SALE_REASON_LABELS: Record<SaleReason, string> = {
  price: "цена",
  time: "время",
  doubt: "неуверенность",
  not_interested: "не интересно",
};

const NO_EMPTY_OUTREACH =
  "Если человек застрял, дай готовый следующий шаг, который можно просто скопировать, например текст запроса. Пустое «вы тут?», «как дела?» и напоминание без пользы нельзя.";

const OUTREACH_TASKS: Record<NonNullable<ProgramTailInput["outreach"]>, string> = {
  morning:
    "Утро нового дня, человек сегодня ещё не писал: напиши первым одно короткое сообщение по теме дня — идею, подсказку или пример, " +
    `связанные с тем, что он уже рассказал. ${NO_EMPTY_OUTREACH}`,
  silence:
    "Человек молчит после твоего прошлого сообщения: напиши первым одно короткое сообщение, которое приносит новое по теме дня — " +
    `идею, подсказку или пример; свои прошлые сообщения не повторяй. ${NO_EMPTY_OUTREACH}`,
};

/**
 * Хвост хода программы: всё, что меняется между ходами и днями. Инструкция версии остаётся прежней —
 * начало запроса берётся из кэша модели. Тексты попутных задач и правила продажи — в инструкции, здесь только состояние.
 */
export function buildProgramTail(input: ProgramTailInput): string {
  const { settings, day } = input;
  const program = settings.program!;
  const lines: string[] = [];

  const zone = input.timeZone ? `пояс ${input.timeZone}` : "пояс неизвестен — считаем по Москве";
  const lastDay =
    day >= program.days
      ? " — последний день программы. Прощание человека сегодня — конец программы: вызови finish_dialog с итогом, а не end_day"
      : "";
  lines.push(`День ${day} из ${program.days}${lastDay}. У человека сейчас ${localTime(input.now, input.timeZone ?? DEFAULT_TIME_ZONE)} (${zone}).`);
  if (input.backlogFromYesterday)
    lines.push("Новый день: сначала ответь на сообщения, которые человек прислал вчера после конца дня, потом веди тему дня.");

  if (input.outreach) lines.push(OUTREACH_TASKS[input.outreach]);
  if (input.outreach && input.saleOfferPaused)
    lines.push("Человек не ответил на твоё прошлое предложение: в этом сообщении не предлагай курс или продукт снова — ни цены, ни ссылки. Помогай по теме дня.");

  lines.push(...stageLines(input));

  if (input.dayLimit === "soft")
    lines.push(`Сегодня человек прислал уже ${input.messagesToday} сообщений: отвечай по делу и по-доброму подводи к прощанию до завтра.`);
  if (input.dayLimit === "last")
    lines.push(
      "Это последнее сообщение человека на сегодня. Ответь по сути и тепло попрощайся до утра: «продолжим утром». Новых вопросов не задавай, finish_dialog не вызывай.",
    );

  const sale = saleLine(input.saleAnswer, day, program.days, input.outreach);
  if (sale) lines.push(sale);

  const open = openSideTasks(program.sideTasks, input.sideTasks, input.personMessageCount);
  if (open.length > 0) lines.push(`Попутные задачи, которые можно решить к слову (не больше одной): ${open.map((task) => task.id).join(", ")}.`);

  return lines.join("\n");
}

function stageLines(input: ProgramTailInput): string[] {
  const { stages } = input.settings;
  const index = Math.max(0, stages.findIndex((stage) => stage.id === input.currentStageId));
  const stage = stages[index];
  if (!stage) return [];
  const lines = [`Текущий этап: ${stage.name} (id: ${stage.id}).`];
  if (input.stageChangedByDay) lines.push(`Этап сменился сам: сегодня день ${input.day}.`);
  lines.push(`Что делать: ${stage.instruction}`);
  if (stage.transitionCondition.trim()) lines.push(`Условие перехода к следующему этапу: ${stage.transitionCondition}`);
  const next = stages.slice(index + 1).find((later) => later.startDay !== null);
  if (next) lines.push(`Этап «${next.name}» включится сам в день ${next.startDay}, раньше — по условию перехода.`);
  return lines;
}

/**
 * Что делать с продажей после отказа. Сообщение первым после мягкого «нет» не продаёт: разобраться
 * можно только в живом ответе. Исключение — одно предложение утром последнего дня.
 */
function saleLine(answer: SaleAnswer | null, day: number, days: number, outreach: ProgramTailInput["outreach"]): string | null {
  if (!answer) return null;
  const reason = SALE_REASON_LABELS[answer.reason];
  if (answer.firm) return `Человек твёрдо отказался от продукта (${reason}): не продавай.`;
  const lastDayOfferAllowed = day >= days && answer.lastOfferDay !== day;
  if (outreach)
    return outreach === "morning" && lastDayOfferAllowed
      ? `Человек мягко отказался от продукта (${reason}). Сегодня последний день: в этом сообщении можно одно предложение с новой стороны, без давления.`
      : `Человек уже мягко отказался от продукта (${reason}): в сообщении первым не продавай — ни предложения, ни цены, ни ссылки на оплату. Помогай по теме дня.`;
  if (!answer.softHandled)
    return `Человек мягко отказался (${reason}): разберись в сомнении один раз; если снова «нет» — вызови sale_answer и вернись к помощи без продажи.`;
  const lastDayOffer = lastDayOfferAllowed ? " Сегодня последний день: можно одно предложение с новой стороны." : "";
  return `Мягкий отказ уже разобран (${reason}): не продавай, пока человек сам не упрётся в то, что даёт продукт.${lastDayOffer}`;
}
