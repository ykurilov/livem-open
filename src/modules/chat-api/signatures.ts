import { createHmac, timingSafeEqual } from "node:crypto";
import type { Clock } from "../platform/clock";
import { isUuid } from "../platform/uuid";

/** Сколько живёт билет голоса: виджет получает новый при каждом входе, то есть при каждой загрузке страницы сайта. */
export const VOICE_TICKET_TTL_MS = 24 * 60 * 60_000;

/**
 * Подписи для того, что браузер на чужом сайте не может отправить с заголовком токена: соединение голоса (WebSocket) и
 * картинка в `<img>`. В них нет токена посетителя — только его id и подпись ключом приложения.
 */
export interface ChatSignatures {
  /** Билет голоса посетителя: `<id>.<до>.<подпись>`. */
  voiceTicket(visitorId: string): string;
  /** Посетитель по билету; подделка, чужой ключ или срок вышел — `null`. */
  visitorOfVoiceTicket(ticket: string | null | undefined): string | null;
  /** Адрес картинки исходящего для этого посетителя от адреса приложения. */
  imageUrl(appOrigin: string, visitorId: string, messageId: string): string;
  /** Посетитель, кому подписана картинка `messageId` (параметры `v` и `s` адреса); иначе `null`. */
  visitorOfImage(messageId: string, params: URLSearchParams): string | null;
}

export function createChatSignatures(key: string, clock: Pick<Clock, "now">): ChatSignatures {
  const sign = (payload: string) => createHmac("sha256", key).update(`chat-api:${payload}`).digest("base64url");
  const matches = (payload: string, signature: string) => {
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  };
  return {
    voiceTicket(visitorId) {
      const until = clock.now().getTime() + VOICE_TICKET_TTL_MS;
      return `${visitorId}.${until}.${sign(`voice:${visitorId}:${until}`)}`;
    },
    visitorOfVoiceTicket(ticket) {
      const parts = ticket?.split(".") ?? [];
      if (parts.length !== 3) return null;
      const [visitorId, until, signature] = parts as [string, string, string];
      if (!isUuid(visitorId) || !/^\d+$/.test(until) || Number(until) <= clock.now().getTime()) return null;
      return matches(`voice:${visitorId}:${until}`, signature) ? visitorId : null;
    },
    imageUrl(appOrigin, visitorId, messageId) {
      const url = new URL(`/api/v1/images/${encodeURIComponent(messageId)}`, appOrigin);
      url.searchParams.set("v", visitorId);
      url.searchParams.set("s", sign(`image:${visitorId}:${messageId}`));
      return url.toString();
    },
    visitorOfImage(messageId, params) {
      const visitorId = params.get("v");
      const signature = params.get("s");
      if (!visitorId || !signature || !isUuid(visitorId)) return null;
      return matches(`image:${visitorId}:${messageId}`, signature) ? visitorId : null;
    },
  };
}
