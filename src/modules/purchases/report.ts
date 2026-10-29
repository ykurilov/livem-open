import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { passages } from "../conversations/schema";
import { getLeadMagnet } from "../lead-magnets";
import type { DatabaseExecutor } from "../platform/db";
import { SCHOOL_CURRENCY } from "./money";
import { productLinksOf } from "./outgoing";
import { productOrders } from "./schema";

export interface PurchaseReport {
  /** Сколько людей лидмагнита оформили заказ продукта (оплаченный или нет). */
  ordered: number;
  /** Сколько оплатили и не вернули. */
  paid: number;
  /** Сколько вернули оплаченный заказ. */
  refunded: number;
  /** Сумма оплат без возвратов — отдельно по каждой валюте (разные валюты не складываются). */
  paidByCurrency: Array<{ currency: string; amount: number }>;
  /** Сколько пообещали оплатить (`payment_promised`). */
  promised: number;
}

/**
 * Отчёт «Покупки» лидмагнита: заказы и оплаты людей, пришедших через него. `null` — у лидмагнита нет ссылок продуктов
 * и ни одного заказа.
 */
export async function purchaseReport(db: DatabaseExecutor, leadMagnetId: string): Promise<PurchaseReport | null> {
  const ofLead = eq(passages.leadMagnetId, leadMagnetId);
  const kept = and(isNotNull(productOrders.paidAt), isNull(productOrders.refundedAt));
  const [counts] = await db
    .select({
      ordered: sql<number>`count(distinct ${productOrders.passageId})`.mapWith(Number),
      paid: sql<number>`count(distinct ${productOrders.passageId}) filter (where ${kept})`.mapWith(Number),
      // Возврат — только оплаченного: отмена до оплаты тоже ставит `refunded_at`, но это не «вернули»
      refunded: sql<number>`count(distinct ${productOrders.passageId}) filter (where ${productOrders.paidAt} is not null and ${productOrders.refundedAt} is not null)`.mapWith(Number),
    })
    .from(productOrders)
    .innerJoin(passages, eq(passages.id, productOrders.passageId))
    .where(ofLead);
  const currency = sql<string>`coalesce(${productOrders.currency}, ${sql.raw(`'${SCHOOL_CURRENCY}'`)})`;
  const sums = await db
    .select({ currency, amount: sql<string>`coalesce(sum(${productOrders.amount}), 0)` })
    .from(productOrders)
    .innerJoin(passages, eq(passages.id, productOrders.passageId))
    .where(and(ofLead, kept))
    .groupBy(currency)
    .orderBy(currency);
  const [promised] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(passages)
    .where(and(ofLead, isNotNull(passages.paymentPromisedAt)));
  const report: PurchaseReport = {
    ordered: counts?.ordered ?? 0,
    paid: counts?.paid ?? 0,
    refunded: counts?.refunded ?? 0,
    paidByCurrency: sums.map((row) => ({ currency: row.currency, amount: Number(row.amount) })),
    promised: promised?.count ?? 0,
  };
  if (report.ordered > 0 || report.promised > 0) return report;
  const lead = await getLeadMagnet(db, leadMagnetId);
  return lead && productLinksOf(lead.draft).length > 0 ? report : null;
}
