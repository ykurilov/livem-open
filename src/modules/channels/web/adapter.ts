import type { ChannelAdapter, OutgoingMessage } from "../channel";

/** Уведомление посетителю веб-чата о новом сообщении, когда страница закрыта (Web Push). */
export interface WebChatNotifier {
  notify(visitorId: string, message: OutgoingMessage): Promise<void>;
}

export interface WebChatAdapterOptions {
  /** Публичный адрес приложения: ссылка на чат — `<адрес>/c/<код>`. */
  publicBaseUrl: string;
  notifier?: WebChatNotifier;
  logError?: (message: string) => void;
}

const NOT_A_MESSENGER = "Веб-чат не подключается как бот мессенджера";

/**
 * Веб-чат как канал. Наружу ничего не шлёт: исходящее со статусом `sent` и есть доставка — страница чата читает его сама.
 * Закрытой странице уходит уведомление; его сбой сообщение недоставленным не делает.
 */
export function createWebChatAdapter(options: WebChatAdapterOptions): ChannelAdapter {
  const base = options.publicBaseUrl.replace(/\/+$/, "");
  const logError = options.logError ?? ((message) => console.error(message));

  return {
    kind: "web",
    ratePerSecond: 50,
    verifyToken: async () => Promise.reject(new Error(NOT_A_MESSENGER)),
    connect: async () => {},
    disconnect: async () => {},
    checkConnection: async () => ({ ok: true }),
    parseWebhook: async () => ({ kind: "rejected" }),
    entryLink: (_bot, code) => `${base}/c/${code}`,

    async send(_bot, to, message) {
      if (!message.text.trim() && !message.imagePath && !message.followUps?.some((text) => text.trim()))
        return { ok: false, reason: "empty" };
      try {
        await options.notifier?.notify(to, message);
      } catch (error) {
        logError(`Веб-чат: уведомление посетителю ${to} не ушло: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { ok: true, externalMessageId: message.idempotencyKey };
    },
  };
}
