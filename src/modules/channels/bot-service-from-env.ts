import { createAlertsFromEnv } from "../alerts";
import { createTokenCipher } from "../platform/crypto";
import { getDatabase } from "../platform/db";
import { optionalEnv, requireEnv } from "../platform/env";
import { getWebQueue } from "../platform/queue";
import { createChannelAdapters } from "./adapters";
import { createBotService, type BotService } from "./bots";

/** Сервис ботов для веб-приложения: база, адаптеры, шифр и адрес — из окружения. */
export function createBotServiceFromEnv(): BotService {
  const { db } = getDatabase();
  return createBotService({
    db,
    adapters: createChannelAdapters(),
    cipher: createTokenCipher(requireEnv("BOT_TOKEN_KEY")),
    alerts: createAlertsFromEnv(db),
    queue: { enqueue: async (name, payload, options) => (await getWebQueue()).enqueue(name, payload, options) },
    publicBaseUrl: optionalEnv("PUBLIC_BASE_URL") ?? "",
    telegramWebhookBaseUrl: optionalEnv("TELEGRAM_WEBHOOK_BASE_URL"),
  });
}
