import type { Clock } from "../platform/clock";
import { systemClock } from "../platform/clock";
import type { Database } from "../platform/db";
import { optionalEnv, telegramApiFromEnv } from "../platform/env";
import { createAlerts, type AlertNotifier, type AlertService } from "./alerts";
import { createTelegramNotifier } from "./telegram-notifier";

/**
 * Тревоги идут отдельным ботом (`ALERT_BOT_TOKEN`). Токена нет — отправка падает с понятной ошибкой, а не молчит.
 * `STUB_CHANNEL=fake` — для сквозных проверок: тревоги пишутся в журнал сервера, в продакшене запрещена.
 */
export function createNotifierFromEnv(env: Record<string, string | undefined> = process.env): AlertNotifier {
  if (env.STUB_CHANNEL === "fake") {
    if (env.NODE_ENV === "production")
      throw new Error("STUB_CHANNEL задана в продакшене: подделка тревог только для проверок. Уберите переменную.");
    return {
      async send(chatId, text) {
        console.warn(`[тревога → ${chatId}] ${text}`);
      },
    };
  }
  const token = optionalEnv("ALERT_BOT_TOKEN", env);
  if (!token) {
    return {
      async send() {
        throw new Error("Не задана переменная окружения ALERT_BOT_TOKEN");
      },
    };
  }
  return createTelegramNotifier({ token, ...telegramApiFromEnv(env) });
}

export function createAlertsFromEnv(db: Database, clock: Clock = systemClock): AlertService {
  return createAlerts({ db, clock, notifier: createNotifierFromEnv() });
}
