import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { passages } from "../conversations/schema";
import type { DatabaseExecutor } from "../platform/db";
import { linkOrdersByEmail, markPurchased, ordersOfPassage } from "./orders";
import { congratulationInAnswer, outboundExists, REMINDER_CLAIM_MS, schedulePaymentReminder, settleOrderReactions, type PurchaseDependencies } from "./reactions";
import { productOrders } from "./schema";
import { purchaseTailLine } from "./tail";
import { productLinksOf } from "./outgoing";
import { getVersion } from "../lead-magnets";
import type { PaymentCheck, PurchasePort } from "./tools";

/**
 * Покупки боевого разговора: обещание ставит напоминание, проверка сверяет заказы прохождения и по почте. Нашлась
 * оплата — покупка отмечена, поздравление модель пишет в этом же ответе. «Поздравлен» отмечает доставка ответа
 * (`noteCongratulationDelivered`); ход не дошёл до ответа — поздравит запасная задача `purchase-congratulate`.
 * Неоплаченный заказ, впервые найденный сверкой по почте (метка реакции ещё стоит), ставит одно напоминание назавтра.
 */
export function passagePurchasePort(deps: PurchaseDependencies): PurchasePort {
  const { db, clock } = deps;
  const passageOf = async (chatId: string) => {
    const [row] = await db
      .select({ id: passages.id, purchasedAt: passages.purchasedAt, congratulatedAt: passages.purchaseCongratulatedAt, paymentEmail: passages.paymentEmail })
      .from(passages)
      .where(eq(passages.chatId, chatId));
    return row ?? null;
  };

  return {
    async promised(chatId) {
      const passage = await passageOf(chatId);
      if (!passage || passage.purchasedAt) return;
      await db
        .update(passages)
        .set({ paymentPromisedAt: sql`coalesce(${passages.paymentPromisedAt}, ${clock.now()})` })
        .where(eq(passages.id, passage.id));
      await schedulePaymentReminder(deps, passage.id);
    },

    async check(chatId, email): Promise<PaymentCheck> {
      const passage = await passageOf(chatId);
      if (!passage) return email ? { kind: "not_found", email } : { kind: "need_email" };
      if (passage.congratulatedAt) return { kind: "already_congratulated" };
      const linked = email ? await linkOrdersByEmail(db, { passageId: passage.id, email, at: clock.now() }) : [];
      // Заказы и покупка — свежие, под замком прохождения, как у реакции на заказ: обработанный возврат покупку не вернёт
      const { paid, unpaid, purchased, firstTime } = await db.transaction(async (tx) => {
        const [locked] = await tx.select({ purchasedAt: passages.purchasedAt }).from(passages).where(eq(passages.id, passage.id)).for("update");
        const orders = await ordersOfPassage(tx, passage.id);
        const marked = orders.paid && !locked?.purchasedAt ? await markPurchased(tx, passage.id, clock.now()) : false;
        return { ...orders, purchased: Boolean(locked?.purchasedAt || orders.paid), firstTime: marked };
      });
      // Метки реакций снимаются после того, что сделала сверка: упала раньше — повтор сверки или подмётчик доведёт
      const handled = [...linked, ...[paid, unpaid].filter((order) => order !== null)];
      if (purchased) {
        await congratulationInAnswer(deps, passage.id);
        await settleOrderReactions(db, handled);
        return { kind: "paid", product: paid?.offerTitle ?? null, firstTime };
      }
      if (unpaid) {
        if (unpaid.reactionPendingAt) await schedulePaymentReminder(deps, passage.id);
        await settleOrderReactions(db, handled);
        return { kind: "unpaid_order" };
      }
      await settleOrderReactions(db, handled);
      const known = email ?? passage.paymentEmail;
      return known ? { kind: "not_found", email: known } : { kind: "need_email" };
    },

    async tailLine(chatId) {
      const [row] = await db
        .select({
          id: passages.id,
          snapshotId: passages.snapshotId,
          purchasedAt: passages.purchasedAt,
          promisedAt: passages.paymentPromisedAt,
          reminderSentAt: passages.paymentReminderSentAt,
          reminderClaimedAt: passages.paymentReminderClaimedAt,
        })
        .from(passages)
        .where(eq(passages.chatId, chatId));
      if (!row) return null;
      const snapshot = await getVersion(db, row.snapshotId);
      const products = snapshot ? productLinksOf(snapshot.settings) : [];
      if (products.length === 0) return null;
      const { paid, unpaid } = await ordersOfPassage(db, row.id);
      const product = products.find((candidate) => (paid ?? unpaid)?.utmCampaign === candidate.campaign) ?? products[0]!;
      return purchaseTailLine({
        purchased: Boolean(row.purchasedAt || paid),
        unpaidOrder: Boolean(unpaid),
        promised: Boolean(row.promisedAt),
        productTitle: product.title,
        remindingNow: await remindingNow(db, row, clock.now()),
      });
    },
  };
}

/** Покупки тестового разговора «Проверки»: напоминаний нет, проверка ищет оплату по почте и ни к кому её не привязывает. */
export function previewPurchasePort(db: DatabaseExecutor): PurchasePort {
  return {
    async promised() {},
    tailLine: async () => null,
    async check(_chatId, email): Promise<PaymentCheck> {
      if (!email) return { kind: "need_email" };
      const [order] = await db
        .select({ paidAt: productOrders.paidAt, offerTitle: productOrders.offerTitle })
        .from(productOrders)
        .where(eq(productOrders.email, email))
        .orderBy(desc(isNotNull(productOrders.paidAt)), desc(productOrders.createdAt))
        .limit(1);
      if (order?.paidAt) return { kind: "paid", product: order.offerTitle, firstTime: false };
      return order ? { kind: "unpaid_order" } : { kind: "not_found", email };
    },
  };
}

/**
 * Напоминание об оплате идёт сейчас: захват свежий (его ставят до хода), отметки «ушло» и исходящего с его ключом ещё
 * нет (они — после хода). Так хвост хода напоминания разрешает ссылку, а следующие ходы — снова нет.
 */
async function remindingNow(
  db: DatabaseExecutor,
  row: { id: string; reminderSentAt: Date | null; reminderClaimedAt: Date | null },
  now: Date,
): Promise<boolean> {
  if (row.reminderSentAt || !row.reminderClaimedAt || now.getTime() - row.reminderClaimedAt.getTime() >= REMINDER_CLAIM_MS) return false;
  return !(await outboundExists(db, `payment-reminder:${row.id}`));
}
