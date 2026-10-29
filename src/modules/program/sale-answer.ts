import type { SaleAnswer, SaleReason, StageHistoryEntry } from "../consultant/schema";

/**
 * Ответ человека на предложение продукта после вызова `sale_answer`.
 * Твёрдое «нет» не отменяется. Второе мягкое «нет» подряд — мягкий отказ разобран: дальше помощь без продажи.
 * `day` — день программы, в который прозвучало предложение: повтор в последний день — не больше одного.
 */
export function nextSaleAnswer(previous: SaleAnswer | null, input: { reason: SaleReason; firm: boolean }, day: number): SaleAnswer {
  const firm = input.firm || Boolean(previous?.firm);
  return {
    reason: input.reason,
    firm,
    softHandled: !firm && Boolean(previous && !previous.firm),
    lastOfferDay: day,
  };
}

/** Этап «Продажа» уже наступал в этом разговоре: он текущий или есть в истории этапов. Раньше отказывать было не от чего. */
export function saleReached(saleStageId: string, state: { currentStageId: string | null; stageHistory: readonly StageHistoryEntry[] }): boolean {
  return state.currentStageId === saleStageId || state.stageHistory.some((entry) => entry.stageId === saleStageId);
}
