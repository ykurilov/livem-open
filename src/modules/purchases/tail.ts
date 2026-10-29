/** Что известно об оплате продукта в этом разговоре — для строки хвоста хода. */
export interface PurchaseState {
  purchased: boolean;
  unpaidOrder: boolean;
  promised: boolean;
  /** Название продукта из настроек; нет — «продукт». */
  productTitle: string | null;
  /** Идёт ход того самого одного напоминания (`payment-reminder`): ссылку в нём можно. */
  remindingNow?: boolean;
}

/**
 * Строка оплаты в хвосте хода: живое состояние, которого нет в постоянной инструкции. Купил — не продавать и не
 * напоминать; заказ без оплаты или обещание — не напоминать самому: напоминание одно, его шлёт приложение.
 */
export function purchaseTailLine(state: PurchaseState): string | null {
  const what = state.productTitle ? `курс «${state.productTitle}»` : "продукт";
  if (state.purchased) return `Человек уже оплатил ${what}: не продавай и не напоминай об оплате, помогай с тем, о чём он просит.`;
  if ((state.unpaidOrder || state.promised) && state.remindingNow)
    return `Это то самое одно напоминание про ${what}: в этом сообщении можно ссылку на оплату — одну, по-доброму, без цены и давления.`;
  if (state.unpaidOrder) return `Человек оформил заказ на ${what}, оплаты пока нет: сам об оплате не напоминай; спросит — ссылка та же.`;
  if (state.promised) return `Человек собирался оплатить ${what}, оплаты пока нет: сам об оплате не напоминай, напоминание уйдёт одно и само.`;
  return null;
}
