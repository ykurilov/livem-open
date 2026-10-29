import { tool, type ToolSet } from "ai";
import { z } from "zod";

/** Что знает разговор об оплате продукта. */
export type PaymentCheck =
  | { kind: "paid"; product: string | null; firstTime: boolean }
  /** Оплата уже учтена и поздравление было: второго не надо. */
  | { kind: "already_congratulated" }
  | { kind: "unpaid_order" }
  | { kind: "need_email" }
  | { kind: "not_found"; email: string };

/** Покупки разговора для инструментов модели: боевое прохождение или тестовый разговор «Проверки». */
export interface PurchasePort {
  /** Человек пообещал оплатить: завтра одно напоминание, если оплаты не будет. */
  promised(chatId: string): Promise<void>;
  /** Человек говорит, что оплатил: есть ли оплата; почта — сверка заказов по ней. */
  check(chatId: string, email: string | null): Promise<PaymentCheck>;
  /** Строка оплаты для хвоста хода (`purchaseTailLine`); нечего сказать — `null`. */
  tailLine(chatId: string): Promise<string | null>;
}

export const PURCHASE_TOOL_NAMES = ["payment_promised", "payment_check"] as const;

const CHECK_ANSWERS: Record<PaymentCheck["kind"], string> = {
  paid: "Оплата есть. Поздравь человека коротко и тепло, один раз. Дальше не продавай и не напоминай об оплате.",
  already_congratulated: "Оплата уже учтена, поздравление было. Подтверди коротко, что всё дошло, без второго поздравления, и помогай дальше.",
  unpaid_order: "Заказ оформлен, но оплата пока не прошла. Скажи это спокойно, без упрёка, и предложи, если что-то не получилось, попробовать ещё раз по той же ссылке.",
  need_email: "Оплату пока не видно. Попроси почту, с которой он платил, — и вызови payment_check снова с ней.",
  not_found:
    "Оплату с этой почтой пока не видно. Скажи честно и без обвинений: «Пока не вижу оплату, проверю позже». Ничего не обещай про сроки; когда оплата придёт, приложение само тебе скажет.",
};

/**
 * Инструменты оплаты продукта — у лидмагнита со ссылками продуктов (`productLinks`), во всех нодах. Описания постоянны
 * у версии — кэш цел. Нет хранилища покупок — инструменты честно отвечают, что проверить нельзя.
 */
export function createPurchaseTools(input: { port: PurchasePort | undefined; chatId: string }): ToolSet {
  const { port, chatId } = input;
  return {
    payment_promised: tool({
      description:
        "Человек сказал, что берёт продукт или оплатит (даже «наверное», «вечером оплачу»). Вызывай до ответа, без текста перед вызовом; " +
        "в ответе дай ссылку на оплату. Если оплаты не будет, завтра приложение само один раз напомнит — сам об оплате больше не напоминай. " +
        "Что будет после оплаты, обещай только то, что есть в фактах о продукте: не обещай, что сам поведёшь человека по продукту.",
      inputSchema: z.strictObject({}),
      execute: async () => {
        await port?.promised(chatId);
        return { ok: true as const };
      },
    }),
    payment_check: tool({
      description:
        "Человек пишет, что уже оплатил продукт, или спрашивает, дошла ли оплата. Вызывай до ответа, без текста перед вызовом. " +
        "email — почта, с которой он платил, если он её назвал; не назвал — не заполняй.",
      inputSchema: z.strictObject({ email: z.string().max(200).optional().describe("Почта, с которой человек платил, как он её написал") }),
      execute: async ({ email }) => {
        if (!port) return { ok: false as const, next: "Проверить оплату здесь нельзя. Скажи, что проверишь позже." };
        const found = await port.check(chatId, email?.trim().toLowerCase() || null);
        return { ok: true as const, paid: found.kind === "paid", next: CHECK_ANSWERS[found.kind] };
      },
    }),
  };
}
