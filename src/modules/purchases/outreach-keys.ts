/** Ключи исходящих, которые Василий пишет первым по покупке: поздравление и напоминание об оплате. */
export const purchaseCongratulationKey = (passageId: string) => `purchase-congratulate:${passageId}`;
export const paymentReminderKey = (passageId: string) => `payment-reminder:${passageId}`;
/** Начала этих ключей: отчёт «Программа» такие сообщения касаниями программы не считает. */
export const PURCHASE_OUTREACH_KEY_PREFIXES = ["purchase-congratulate:", "payment-reminder:"] as const;

/** Строка журнала расхода SDK для ходов, где Василий пишет первым по покупке, — отдельно от касаний программы. */
export const PURCHASE_USAGE_SOURCE = "purchase_message";
