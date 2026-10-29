/**
 * Код ссылок тестового разговора «Проверки»: `t` и хэш чата. Считается одинаково на сервере и в браузере; заказ с ним
 * ляжет неизвестным — тестовая оплата ни на кого не запишется.
 */
export function previewTrackingCode(chatId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < chatId.length; index++) hash = Math.imul(hash ^ chatId.charCodeAt(index), 0x01000193) >>> 0;
  return `t${hash.toString(36).padStart(7, "0").slice(-7)}`;
}

/** Канал ссылок «Проверки» (`utm_medium`). */
export const PREVIEW_MEDIUM = "preview";
