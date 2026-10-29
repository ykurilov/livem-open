import type { StoredMessage } from "@ykurilov/agent-chat-core";

/**
 * Просьба «напиши первым» лежит в истории консультанта сообщением собеседника, как ответ эксперта, и помечена своей частью.
 * Модель видит только текст; по пометке карточка человека, «Входящие» и eval прячут её: человек этого не писал.
 */
export const OUTREACH_REQUEST_PART_TYPE = "data-outreach-request";

/**
 * Текст просьбы одинаков у всех сообщений первым: он остаётся в истории, и начало следующих запросов не меняется.
 * Что именно написать сегодня, приходит хвостом хода.
 */
export const OUTREACH_REQUEST_TEXT = "[Служебно, человек этого не видел: человек молчит. Напиши ему первым — что именно, сказано ниже.]";

export function outreachRequestParts(): StoredMessage["parts"] {
  return [
    { type: OUTREACH_REQUEST_PART_TYPE, data: {} },
    { type: "text", text: OUTREACH_REQUEST_TEXT },
  ];
}

export function isOutreachRequest(message: Pick<StoredMessage, "parts">): boolean {
  return message.parts.some((part) => part.type === OUTREACH_REQUEST_PART_TYPE);
}
