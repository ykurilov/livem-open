import { systemClock } from "../platform/clock";
import { optionalEnv, requireEnv } from "../platform/env";
import { createChatSignatures, type ChatSignatures } from "./signatures";

/** Подписи билетов голоса и картинок — ключом приложения, тем же, что шифрует токены ботов. */
export function chatSignaturesFromEnv(env: Record<string, string | undefined> = process.env): ChatSignatures {
  return createChatSignatures(requireEnv("BOT_TOKEN_KEY", env), systemClock);
}

/**
 * Адрес приложения: от него ссылки на картинки и по нему узнаётся свой сайт. Без `PUBLIC_BASE_URL` (разработка) — адрес,
 * на который пришёл запрос.
 */
export function appOriginOf(request: Request, env: Record<string, string | undefined> = process.env): string {
  return optionalEnv("PUBLIC_BASE_URL", env) ?? new URL(request.url).origin;
}
