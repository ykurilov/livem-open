import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { LeadMagnetSettings } from "../lead-magnets";
import { answerWithoutFarewellRepeats } from "./closing-answer";
import { lastReplyRule } from "./instruction";
import { SALE_TAG } from "../flows/settings-to-flow";
import type { ConversationStore } from "./preview-store";
import { DIALOG_OUTCOMES, SALE_REASONS } from "./schema";
import { productLinksOf } from "../purchases/outgoing";
import { createPurchaseTools, PURCHASE_TOOL_NAMES } from "../purchases/tools";
import { createTextLinkTool, TEXT_LINK_TOOL } from "../text-links";

export const CONSULTANT_TOOL_NAMES = ["finish_dialog", "sale_answer", ...PURCHASE_TOOL_NAMES, TEXT_LINK_TOOL] as const;

export const dialogSummaryInput = z.strictObject({
  goal: z.string().min(1).describe("Цель человека его словами"),
  stuckAt: z.string().min(1).describe("Где он застрял"),
  chosenStep: z.string().min(1).describe("Какой следующий шаг он выбрал"),
  outcome: z.enum(DIALOG_OUTCOMES).describe("agreed — согласился с итогом, declined — отказался или отложил решение, left — просто ушёл или перестал отвечать"),
  answer: z.string().max(200).optional().describe(answerDescription("")),
});

/** Описание answer одно на версию лидмагнита: в нём прощание из настроек, чтобы модель его не пересказывала. */
function answerDescription(farewellMessage: string): string {
  const farewell = farewellMessage.trim();
  return (
    "Только если человек в последней реплике задал вопрос — только ответ на него, коротко, до 200 знаков. Вопроса нет — не заполняй. " +
    (farewell ? `Следом человек получит прощание «${farewell}». ` : "") +
    "Не повторяй, кто, как и когда свяжется, не благодари и не прощайся. Если прощание уже отвечает на вопрос, не заполняй. " +
    "Сроки и порядок связи, которых нет в инструкции, не выдумывай: скажи, что эксперт свяжется и уточнит."
  );
}

/**
 * Инструменты консультанта для одного разговора: итог и ответ на предложение продукта. Ошибки возвращаются модели, не
 * бросаются. Переходы, память о человеке, пояс, «до завтра» и попутные задачи — служебные инструменты сценария SDK
 * (`flow_exit`, `flow_note`, `flow_time_zone`, `flow_close_day`, `flow_side_task`).
 */
export function createConsultantTools(input: {
  store: ConversationStore;
  chatId: string;
  settings: LeadMagnetSettings;
  /** День программы для ответа на продажу; без «Дней и времени» — 1. */
  saleDay(): Promise<number>;
}): ToolSet {
  const { store, chatId, settings } = input;
  const program = settings.flow.schedule !== undefined;
  // Оплату продукта мы узнаём сами: «да» продукту не конец программы, помощь идёт до конца срока
  const tracksPurchases = productLinksOf(settings).length > 0;
  const tools: ToolSet = {
    finish_dialog: tool({
      description: program
        ? tracksPurchases
          ? PROGRAM_FINISH_WITH_PURCHASES_DESCRIPTION
          : PROGRAM_FINISH_DESCRIPTION
        : "Завершить разговор: после явного согласия человека с пересказанным итогом или сразу, если человек сам прощается, просит закончить или отказывается продолжать. " +
          "Если человек отказался от шага — сразу, с исходом declined. «Подумаю», «не сейчас» и отложенное решение — тоже declined; left — только если человек просто ушёл или перестал отвечать. " +
          "Сомнение или условие — не согласие. Вызывай до последнего ответа человеку, без текста перед вызовом.",
      inputSchema: dialogSummaryInput.extend({ answer: z.string().max(200).optional().describe(answerDescription(settings.farewellMessage)) }),
      execute: async (summary) => {
        const answer = summary.answer && answerWithoutFarewellRepeats(summary.answer, settings.farewellMessage);
        await store.finish(chatId, { ...summary, ...(summary.answer !== undefined && { answer }) });
        return {
          ok: true as const,
          next: `Разговор завершён. ${lastReplyRule(settings.farewellMessage, summary.outcome)}`,
        };
      },
    }),
  };
  // Только в ноде с меткой «продажа»: в чужой ноде сценарий SDK ответит модели «в этом состоянии недоступно»
  if (settings.flow.states.some((state) => state.tags.includes(SALE_TAG)))
    tools.sale_answer = tool({
      description:
        "Записать отказ человека от продукта: причина и твёрдое ли «нет». Вызывай на каждое «нет» продукту из этапа «Продажа», и на первое мягкое («дорого», «подумаю») тоже. " +
        "Отказ от другого — от идеи, игры, шага, совета — не sale_answer: его не вызывай. Сомнение вопросом («а если не сдам?») — тоже не «нет». " +
        "Твёрдое — больше не продаёшь; мягкое — разбираешь один раз, повторное мягкое — возврат к помощи без продажи. " +
        "Вызывай до ответа человеку, без текста перед вызовом.",
      inputSchema: z.strictObject({
        reason: z.enum(SALE_REASONS).describe("price — цена, time — время, doubt — неуверенность, not_interested — не интересно"),
        firm: z.boolean().describe("true — твёрдое «нет» («не интересно», «не нужно»), false — мягкое («дорого», «подумаю», «не потяну»)"),
      }),
      execute: async (answer) => {
        await store.saleAnswer(chatId, answer, await input.saleDay());
        return { ok: true as const };
      },
    });
  if (tracksPurchases) Object.assign(tools, createPurchaseTools({ port: store.purchases, chatId }));
  // Во всех нодах, как инструменты оплаты: сценарий SDK про него не знает
  const { textLink } = settings;
  if (textLink) {
    const shorten = store.shortLinks && ((target: string) => store.shortLinks!.shorten({ chatId, template: textLink.template, target }));
    tools[TEXT_LINK_TOOL] = createTextLinkTool(textLink, shorten);
  }
  return tools;
}

const PROGRAM_FINISH_DESCRIPTION =
  "Завершить программу: после «да» продукту или следующему шагу — с исходом agreed; если человек просит прекратить, не писать ему или отказывается продолжать — сразу, с исходом declined. " +
  "agreed — только при ясном «да» или конкретном действии: перешёл по ссылке, спросил, как оплатить; «кажется, в деле», «вроде интересно» — не согласие, сначала уточни. " +
  "Мягкое «нет», «подумаю», «не сейчас» и прощание до утра — не повод завершать. Вызывай до последнего ответа человеку, без текста перед вызовом.";

/** Программа, у которой оплату продукта узнаёт приложение: «да» — ссылка и `payment_promised`, а не конец. */
const PROGRAM_FINISH_WITH_PURCHASES_DESCRIPTION =
  "Завершить программу: если человек просит прекратить, не писать ему или отказывается продолжать — сразу, с исходом declined; в последний день программы — на прощание человека. " +
  "«Да» продукту, обещание оплатить и сама оплата — не повод завершать: дай ссылку, вызови payment_promised и помогай дальше до конца программы. " +
  "Мягкое «нет», «подумаю», «не сейчас» и прощание до утра — тоже не повод. Вызывай до последнего ответа человеку, без текста перед вызовом.";
