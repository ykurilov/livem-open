import type { AlertNotifier } from "./alerts";

export interface TelegramNotifierConfig {
  token: string;
  /** Адрес Bot API. С российского сервера — наш прокси-маршрут (`TELEGRAM_API_BASE_URL`). */
  apiBaseUrl?: string;
  /** Пропуск нашего прокси (`X-Proxy-Token`): нужен, когда `apiBaseUrl` — прокси-маршрут. */
  proxyToken?: string;
  fetch?: typeof fetch;
  /** Сколько ждать ответа Telegram, мс. Нужен тестам; по умолчанию 15 секунд. */
  requestTimeoutMs?: number;
}

const DEFAULT_TELEGRAM_API = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 15_000;

/** Отправляет тревоги в Telegram отдельным ботом (`ALERT_BOT_TOKEN`), не ботами лидмагнитов. */
export function createTelegramNotifier(config: TelegramNotifierConfig): AlertNotifier {
  const baseUrl = (config.apiBaseUrl ?? DEFAULT_TELEGRAM_API).replace(/\/+$/, "");
  const request = config.fetch ?? fetch;
  const timeoutMs = config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    async send(chatId, text) {
      let response: Response;
      try {
        response = await request(`${baseUrl}/bot${config.token}/sendMessage`, {
          method: "POST",
          headers: {
            ...(config.proxyToken ? { "x-proxy-token": config.proxyToken } : {}),
            "content-type": "application/json",
          },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Текст сетевой ошибки может содержать адрес запроса, а в нём токен
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Telegram не ответил: ${reason.replaceAll(config.token, "***")}`);
      }
      if (response.ok) return;
      const details = (await response.json().catch(() => null)) as { description?: string } | null;
      throw new Error(`Telegram ответил ${response.status}: ${details?.description ?? "без пояснения"}`);
    },
  };
}
