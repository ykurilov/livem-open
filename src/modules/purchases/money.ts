/** Школа продаёт в рублях: валюта не пришла в уведомлении — рубли. */
export const SCHOOL_CURRENCY = "RUB";

/** Сумма для людей: «2 990 ₽», «1 299 $». Неизвестный код валюты — числом с кодом. */
export function formatMoney(amount: number, currency: string | null): string {
  const code = currency ?? SCHOOL_CURRENCY;
  try {
    return new Intl.NumberFormat("ru-RU", { style: "currency", currency: code, maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount.toLocaleString("ru-RU")} ${code}`;
  }
}
