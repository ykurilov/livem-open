import { index, integer, jsonb, numeric, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { passages } from "../conversations/schema";
import { appSchema } from "../platform/app-schema";

/** Откуда заказ. */
export const ORDER_SOURCES = ["getcourse"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/** Как заказ связан с прохождением: по личному коду в ссылке или по почте, с которой платили. */
export const ORDER_MATCHES = ["code", "email"] as const;
export type OrderMatch = (typeof ORDER_MATCHES)[number];

/**
 * Заказы продуктов из уведомлений платёжной школы. Каждый заказ — одна строка: повтор уведомления и смена статуса её
 * обновляют. Заказ без человека тоже лежит: его найдёт сверка по почте (`payment_check`).
 */
export const productOrders = appSchema.table(
  "product_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").$type<OrderSource>().notNull(),
    /** Id заказа в школе. */
    externalOrderId: text("external_order_id").notNull(),
    orderNumber: text("order_number"),
    /** Статус словами школы («Новый», «Завершён», «Оплачен»…). */
    status: text("status").notNull(),
    /** Сумма заказа в валюте `currency`. */
    amount: numeric("amount", { precision: 12, scale: 2 }),
    /** Код валюты (RUB, USD…); неизвестна — пусто. */
    currency: text("currency"),
    /** Почта строчными. */
    email: text("email"),
    externalUserId: text("external_user_id"),
    offerTitle: text("offer_title"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),
    passageId: uuid("passage_id").references(() => passages.id),
    matchedBy: text("matched_by").$type<OrderMatch>(),
    /** Первое уведомление об оплате: по нему поздравление и отчёт. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** Возврат: покупка снята, в отчёте — «вернули», если заказ был оплачен. Пришёл раньше оплаты — заказ закрыт, оплата не в счёт. */
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    /** Уведомление записано, реакция на него (покупка, поздравление, напоминание) ещё не исполнена: её доведёт подмётчик. */
    reactionPendingAt: timestamp("reaction_pending_at", { withTimezone: true }),
    /** Номер перемены, ждущей реакции: реакция снимает метку, только если за это время не пришло новой. */
    reactionRevision: integer("reaction_revision").notNull().default(0),
    /** Последнее уведомление как пришло — для сверки. */
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("product_orders_source_order").on(table.source, table.externalOrderId),
    index("product_orders_passage").on(table.passageId),
    index("product_orders_email").on(table.email),
  ],
);

export type ProductOrder = typeof productOrders.$inferSelect;
