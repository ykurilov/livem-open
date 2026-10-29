import { createHash, timingSafeEqual } from "node:crypto";

/** Что с заказом: оплачен, возвращён (или отменён после оплаты), остальное — открыт. */
export type OrderNoticeKind = "paid" | "refunded" | "open";

/** Заказ из уведомления GetCourse (процесс «Вызвать URL»). */
export interface OrderNotice {
  externalOrderId: string;
  orderNumber: string | null;
  status: string;
  kind: OrderNoticeKind;
  amount: number | null;
  /** Код валюты (RUB, USD…); неизвестна — `null`. */
  currency: string | null;
  /** Строчными. */
  email: string | null;
  externalUserId: string | null;
  offerTitle: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null };
}

/** Имя переменной окружения с секретом адреса уведомлений. */
export const GETCOURSE_SECRET_ENV = "GETCOURSE_WEBHOOK_SECRET";

/** Только однозначные статусы оплаченного заказа: «Не завершён», «Частично оплачен» сюда не попадут. */
const PAID_STATUSES = new Set(["завершён", "завершен", "оплачен", "оплачено", "completed", "complete", "finished", "paid", "payed"]);
const REFUND_STATUSES = new Set(["возврат", "возвращён", "возвращен", "отменён", "отменен", "отмена", "refunded", "refund", "cancelled", "canceled"]);
const PAID_EVENT = "order_paid";
const REFUND_EVENTS = new Set(["order_refunded", "order_cancelled", "order_canceled"]);

/** Пределы длины полей: тело чужое, в базу лишнего не пишем. */
const ID_MAX = 100;
const SHORT_MAX = 200;
const TEXT_MAX = 500;
const EMAIL_MAX = 320;
/** Больше суммы не бывает: столбец numeric(12, 2). */
const AMOUNT_MAX = 9_999_999_999;

/** Значение поля как строка: числа — строкой, пустое и незаполненная переменная GetCourse («{object.x}») — `null`. */
function textOf(value: unknown, max = SHORT_MAX): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || /^\{[^{}]*\}$/.test(text)) return null;
  return text.slice(0, max);
}

const firstText = (max: number, ...values: unknown[]) => values.map((value) => textOf(value, max)).find((text) => text !== null) ?? null;

const CURRENCY_SIGNS: Array<[RegExp, string]> = [
  [/₽|руб|\brub\b|\br\.?$/i, "RUB"],
  [/\$|\busd\b|долл/i, "USD"],
  [/€|\beur\b|евро/i, "EUR"],
  [/₸|\bkzt\b|тенге/i, "KZT"],
  [/₴|\buah\b|грн/i, "UAH"],
  [/\bbyn\b|бел\.?\s*руб/i, "BYN"],
];

/** Код валюты по знаку или слову; трёхбуквенный код — как есть. */
function currencyOf(text: string | null): string | null {
  if (!text) return null;
  if (/^[a-z]{3}$/i.test(text)) return text.toUpperCase();
  return CURRENCY_SIGNS.find(([sign]) => sign.test(text))?.[1] ?? null;
}

/**
 * Сумма и валюта из текста: «2 990 руб.», «1 299,00», «$1,299.00», «1.299,00 €», «0.00». Разделитель дробной части —
 * последний «.» или «,» с одной-двумя цифрами после; остальные — разряды. Не число или больше предела — без суммы.
 */
export function moneyOf(text: string | null): { amount: number | null; currency: string | null } {
  const none = { amount: null, currency: null };
  if (!text) return none;
  const digits = text.replace(/[\s\u00a0\u202f']/g, "").replace(/[^\d.,-]/g, "").replace(/^[.,]+|[.,]+$/g, "");
  if (!/\d/.test(digits)) return none;
  const decimal = digits.match(/[.,](\d{1,2})$/);
  const whole = (decimal ? digits.slice(0, -decimal[0].length) : digits).replace(/[.,](?=\d{3}(?:[.,]|$))/g, "");
  if (!/^-?\d+$/.test(whole)) return none;
  const amount = Number(decimal ? `${whole}.${decimal[1]}` : whole);
  if (!Number.isFinite(amount) || Math.abs(amount) > AMOUNT_MAX) return none;
  return { amount, currency: currencyOf(text) };
}

/** Вид заказа по статусу (и событию процесса, если есть). */
export function orderKindOf(status: string, event: string | null = null): OrderNoticeKind {
  const normalized = status.trim().toLowerCase();
  if ((event && REFUND_EVENTS.has(event)) || REFUND_STATUSES.has(normalized)) return "refunded";
  if (event === PAID_EVENT || PAID_STATUSES.has(normalized)) return "paid";
  return "open";
}

/** Разбор тела уведомления: плоский JSON процесса или форма; вложенный `user` тоже понимается. Не заказ — `null`. */
export function parseGetCourseNotice(body: unknown): OrderNotice | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  const user = typeof data.user === "object" && data.user !== null ? (data.user as Record<string, unknown>) : {};
  const externalOrderId = firstText(ID_MAX, data.id, data.order_id, data.deal_id);
  if (!externalOrderId) return null;
  const status = firstText(SHORT_MAX, data.status, data.deal_status) ?? "";
  const event = firstText(SHORT_MAX, data.event);
  const email = firstText(EMAIL_MAX, data.email, data.user_email, user.email)?.toLowerCase() ?? null;
  // Сумма — из первого заполненного поля; валюта — отдельным полем, иначе из стоимости с валютой («{object.cost_money}»)
  const money = moneyOf(firstText(SHORT_MAX, data.cost, data.cost_money_value, data.cost_money, data.deal_cost));
  const currency = currencyOf(firstText(SHORT_MAX, data.currency)) ?? money.currency ?? currencyOf(firstText(SHORT_MAX, data.cost_money));
  return {
    externalOrderId,
    orderNumber: firstText(ID_MAX, data.number, data.order_number, data.deal_number),
    status,
    kind: orderKindOf(status, event),
    amount: money.amount,
    currency,
    email,
    externalUserId: firstText(ID_MAX, data.user_id, user.id),
    offerTitle: firstText(TEXT_MAX, data.offer, data.offers, data.positions),
    utm: {
      source: firstText(SHORT_MAX, data.utm_source),
      medium: firstText(SHORT_MAX, data.utm_medium),
      campaign: firstText(SHORT_MAX, data.utm_campaign),
      content: firstText(SHORT_MAX, data.utm_content),
      term: firstText(SHORT_MAX, data.utm_term),
    },
  };
}

/** Секрет адреса совпал: сравнение за постоянное время, пустой секрет не подходит никогда. */
export function sameSecret(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  // Хэши одной длины: время сравнения не зависит ни от длины, ни от совпавшего начала
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(expected)) && given.length === expected.length;
}
