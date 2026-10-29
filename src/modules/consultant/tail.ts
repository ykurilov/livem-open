import type { FlowDayInfo, FlowFirstReason } from "@ykurilov/agent-chat-flows";
import type { LeadMagnetSettings } from "../lead-magnets";
import type { SaleAnswer, SaleReason } from "./schema";

/** За сколько сообщений до предела консультант начинает видеть обратный отсчёт. */
export const COUNTDOWN_FROM = 5;

function messagesWord(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "сообщений";
  if (last === 1) return "сообщение";
  if (last >= 2 && last <= 4) return "сообщения";
  return "сообщений";
}

/**
 * Наш хвост хода человека: обратный отсчёт до предела сообщений. Этап, день, время, рамки дня и попутные задачи
 * дописывает сценарий SDK после него. У программы на несколько дней предела нет — его заменяют рамки дня.
 * `personMessageCount` — сколько сообщений человек уже прислал, включая это.
 */
export function buildConsultantTail(input: { settings: LeadMagnetSettings; personMessageCount: number }): string | null {
  const { settings, personMessageCount } = input;
  if (settings.flow.schedule) return null;
  const left = settings.maxPersonMessages - personMessageCount;
  if (left <= 0) return "Это последнее сообщение человека: заверши разговор сейчас и вызови finish_dialog.";
  if (left <= COUNTDOWN_FROM) return `До конца разговора осталось ${left} ${messagesWord(left)} человека.`;
  return null;
}

const SALE_REASON_LABELS: Record<SaleReason, string> = {
  price: "цена",
  time: "время",
  doubt: "неуверенность",
  not_interested: "не интересно",
};

export interface SaleTailInput {
  /** Ответ человека на предложение продукта (`sale_answer`); не было — `null`. */
  saleAnswer: SaleAnswer | null;
  /** Разговор сейчас в ноде с меткой «продажа». */
  inSale: boolean;
  /** День программы из сценария; без «Дней и времени» — `null`. */
  day: Pick<FlowDayInfo, "day" | "isLastDay"> | null;
  /** Почему агент пишет первым в этом ходе (`stepContext` сценария); ход на сообщение человека — нет. */
  firstReasons?: readonly FlowFirstReason[];
}

/**
 * Строка продажи в хвосте. Правило держит код, а не модель: в сообщении первым после тишины курс не
 * предлагается — кроме одного предложения утром последнего дня. Постоянная инструкция от этого не меняется: кэш цел.
 */
export function saleTailLine(input: SaleTailInput): string | null {
  const { saleAnswer: answer, day, firstReasons = [] } = input;
  const reason = answer && SALE_REASON_LABELS[answer.reason];
  if (answer?.firm) return `Человек твёрдо отказался от продукта (${reason}): не продавай.`;

  if (firstReasons.length > 0) {
    if (!input.inSale && !answer) return null;
    const lastMorning = Boolean(day?.isLastDay) && firstReasons.some((first) => first.kind === "morning") && answer?.lastOfferDay !== day?.day;
    if (lastMorning)
      return "Сегодня последний день программы: в этом сообщении можно одно предложение курса с новой стороны, без давления.";
    if (answer)
      return `Человек уже мягко отказался от продукта (${reason}): в сообщении первым не продавай — ни предложения, ни цены, ни ссылки на оплату. Помогай по теме дня.`;
    // «Продажа» включилась в этом же касании (по дню): курс ещё не предлагали — первое предложение можно.
    if (firstReasons.some((first) => first.kind === "transition"))
      return "Этап продажи начался в этом сообщении: в этом сообщении можно предложить продукт один раз, без давления.";
    return "Человек не ответил на твоё предложение и молчит: курс и продукт в этом сообщении не предлагай — ни цены, ни ссылки на оплату. Помогай по теме.";
  }

  if (!answer) return null;
  if (!answer.softHandled)
    return `Человек мягко отказался (${reason}): разберись в сомнении один раз; если снова «нет» — вызови sale_answer и вернись к помощи без продажи.`;
  const lastDayOffer = day?.isLastDay && answer.lastOfferDay !== day.day ? " Сегодня последний день: можно одно предложение с новой стороны." : "";
  return `Мягкий отказ уже разобран (${reason}): не продавай, пока человек сам не упрётся в то, что даёт продукт.${lastDayOffer}`;
}
