import type { OutgoingMessage } from "../channels/channel";
import type { WebChatNotifier } from "../channels/web/adapter";
import type { Clock } from "../platform/clock";
import type { JobEnqueuer } from "../platform/queue";

/**
 * Страница спрашивала новые сообщения не раньше этого — она открыта, человек видит ответ и без уведомления.
 * Открытая страница обновляет отметку не реже раза в 10–12,5 с (опрос раз в 2,5 с, запись не чаще раза в 10 с), а скрытая
 * стирает её сразу.
 */
export const PAGE_OPEN_WINDOW_MS = 15_000;

const BODY_LIMIT = 160;

/** Подписка браузера на уведомления (`PushSubscription.toJSON()`). */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushVisitor {
  id: string;
  pushSubscription: WebPushSubscription | null;
  lastSeenAt: Date | null;
  /** Код ссылки, по которой посетитель открыл чат: нажатие на уведомление ведёт туда. */
  lastCode: string | null;
  /** Заголовок уведомления — название лидмагнита. */
  title: string;
}

export interface WebPushNotifierDependencies {
  clock: Clock;
  findVisitor(visitorId: string): Promise<PushVisitor | null>;
  /** Снять подписку, если у посетителя всё ещё та, по которой слали: новую, сохранённую за время отправки, не трогать. */
  clearSubscription(visitorId: string, endpoint: string): Promise<void>;
  /** Отправка в службу уведомлений браузера; сбой — исключение с `statusCode`. */
  send(subscription: WebPushSubscription, payload: string): Promise<void>;
}

/** Службы уведомлений браузеров: Chrome и Android, Firefox, Safari, Edge. На другие адреса сервер запросов не шлёт. */
const PUSH_SERVICE_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];

/** Адрес подписки — служба уведомлений браузера по https на обычном порту, а не произвольный сервер. */
export function isWebPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.port === "" && !url.username && !url.password && PUSH_SERVICE_HOSTS.some((host) => host.test(url.hostname));
}

/** Нажатие на уведомление: страница ведёт в текущий разговор, если с тех пор человек перешёл в другой. */
export const NOTIFICATION_PARAM = "from=notification";

/** Подписка больше не действует: человек отозвал разрешение или удалил веб-приложение. */
const GONE_STATUSES = new Set([404, 410]);

/**
 * Уведомление о сообщении — отдельной задачей очереди, а не внутри отправки: временный сбой службы уведомлений повторяет
 * только уведомление (сообщение в ленте уже есть), а отправка сообщения его не ждёт.
 */
export function queuedWebChatNotifier(queue: JobEnqueuer): WebChatNotifier {
  return {
    async notify(visitorId, message) {
      await queue.enqueue("web-chat-push", { visitorId, body: webChatNotificationBody(message) });
    },
  };
}

/** Отправка уведомления (задача `web-chat-push`). Временный сбой — исключение: задача повторится. */
export function createWebPushSender(deps: WebPushNotifierDependencies): { push(visitorId: string, body: string): Promise<void> } {
  return {
    async push(visitorId, body) {
      const visitor = await deps.findVisitor(visitorId);
      if (!visitor?.pushSubscription || !visitor.lastCode) return;
      const { endpoint } = visitor.pushSubscription;
      if (!isWebPushEndpoint(endpoint)) return deps.clearSubscription(visitorId, endpoint);
      if (visitor.lastSeenAt && deps.clock.now().getTime() - visitor.lastSeenAt.getTime() < PAGE_OPEN_WINDOW_MS) return;
      const payload = { title: visitor.title, body, url: `/c/${visitor.lastCode}?${NOTIFICATION_PARAM}`, tag: "web-chat" };
      try {
        await deps.send(visitor.pushSubscription, JSON.stringify(payload));
      } catch (error) {
        const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
        if (typeof statusCode === "number" && GONE_STATUSES.has(statusCode)) return deps.clearSubscription(visitorId, endpoint);
        throw error;
      }
    },
  };
}

export function webChatNotificationBody(message: OutgoingMessage): string {
  const text = [message.text, ...(message.followUps ?? [])].map((part) => part.trim()).find(Boolean);
  if (!text) return "Новое сообщение";
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length <= BODY_LIMIT ? oneLine : `${oneLine.slice(0, BODY_LIMIT - 1).trimEnd()}…`;
}
