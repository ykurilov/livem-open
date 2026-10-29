// Общий интерфейс мессенджера. Остальной код знает только эти типы (конституция II).

export type ChannelKind = "telegram" | "vk" | "max";

export const CHANNEL_LABELS: Record<ChannelKind, string> = { telegram: "Telegram", vk: "ВКонтакте", max: "Max" };

/** Всё, что адаптеру нужно знать о боте. Токен здесь уже расшифрован. */
export interface BotCredentials {
  id: string;
  token: string;
  externalId: string;
  username: string;
  webhookSecret: string;
}

export interface WebhookRequest {
  /** Имена заголовков строчными буквами. */
  headers: Record<string, string>;
  body: string;
}

export type ParsedWebhook =
  | { kind: "rejected" }
  | { kind: "handshake"; responseBody: string } // ВК: confirmation
  | { kind: "events"; events: ChannelEvent[]; responseBody: string }; // ВК: "ok"

export type AttachmentKind = "image" | "voice" | "sticker" | "file" | "other";

/** Откуда человек, если пришёл не через лидмагнит, а из другого сервиса. Пока таких источников нет. */
export const CONTACT_SOURCES = [] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export const CONTACT_SOURCE_LABELS: Record<ContactSource, string> = {};

export type ChannelEvent =
  | {
      type: "message";
      dedupeKey: string;
      userId: string;
      userName?: string;
      text: string;
      attachment?: AttachmentKind;
      /** `/start <код>`, `ref`, `bot_started.payload` */
      startCode?: string;
    }
  | { type: "button"; dedupeKey: string; userId: string; callbackId: string; payload: string }
  | { type: "blocked"; dedupeKey: string; userId: string }
  | { type: "unblocked"; dedupeKey: string; userId: string }
  /** Человек написал боту ради другого сервиса (отвечает тот): не разговор, а контакт, которому можно писать. */
  | { type: "contact"; dedupeKey: string; userId: string; source: ContactSource };

export interface OutgoingMessage {
  /** Ссылки — простым текстом или HTML, по каналу. */
  text: string;
  imagePath?: string;
  buttons?: Array<{ label: string; payload: string }>;
  /** Отдельные сообщения после основного, по порядку: ролик консультанта, прощание. Кнопки остаются на основном. */
  followUps?: string[];
  idempotencyKey: string;
  /**
   * Сколько частей этого сообщения уже ушло при прошлых попытках (картинка, куски длинного текста и дополнительных сообщений — отдельные части).
   * Адаптер начинает с первой неотправленной, чтобы повтор не слал одно и то же дважды.
   */
  sentParts?: number;
}

/** Сбой отправки. `sentParts` — сколько частей сообщения ушло к этому моменту, считая прошлые попытки. */
export type SendFailure = (
  | { reason: "blocked" }
  /** Мессенджер не даёт написать первым: человек давно не отвечал (ВК, 950). Не блокировка — пройдёт, когда человек напишет. */
  | { reason: "reply_window_closed" }
  | { reason: "rate_limited"; retryAfterMs: number }
  | { reason: "temporary"; error: string }
  | { reason: "permanent"; error: string }
  /** Отправлять нечего: ни текста, ни картинки, ни дополнительных сообщений. В мессенджер запрос не уходил. */
  | { reason: "empty" }
) & { ok: false; sentParts?: number };

export type SendResult = { ok: true; externalMessageId: string } | SendFailure;

/**
 * Итог проверки бота. `invalid_token` — токен отозван или бота нет: чинить нужно человеку.
 * `taken_over` — наш приём сообщений заняли: бота подключили к другому сервису. Само не пройдёт.
 * `temporary` — сеть, прокси или ограничение скорости: может пройти само.
 */
export type ConnectionCheck = { ok: true } | { ok: false; kind: "invalid_token" | "taken_over" | "temporary"; error: string };

export interface BotIdentity {
  externalId: string;
  username: string;
  title: string;
}

export interface ChannelAdapter {
  kind: ChannelKind;
  /** Для очереди отправки: не больше стольких сообщений в секунду на бота. */
  ratePerSecond: number;

  verifyToken(token: string): Promise<BotIdentity>;
  /**
   * Перед подключением: не читает ли бота уже другой сервис. Подключение перебьёт чужой приём, поэтому о нём спрашиваем эксперта.
   * `ownWebhookUrl` — наш адрес для этого бота (`null`, если бота у нас ещё нет). Возвращает предупреждение для эксперта
   * или `null`, если бот свободен. Не смогла проверить — бросает исключение: молча подключать вслепую нельзя.
   */
  findConflict?(token: string, ownWebhookUrl: string | null): Promise<string | null>;
  /** Настроить приём сообщений на адрес `webhookUrl`. */
  connect(bot: BotCredentials, webhookUrl: string): Promise<void>;
  /** Убрать приём сообщений. `webhookUrl` — тот же адрес, что передали в `connect`: чужие подписки не трогаем. */
  disconnect(bot: BotCredentials, webhookUrl: string): Promise<void>;
  /**
   * Проверка, что бот жив и токен действует (раз в 10 минут). Не бросает исключений: итог — в результате.
   * С `webhookUrl` (наш адрес) проверяется ещё, что приём сообщений всё ещё наш.
   */
  checkConnection(bot: BotCredentials, webhookUrl?: string): Promise<ConnectionCheck>;
  /** Быстрая проверка вида токена до обращения к мессенджеру. Текст ошибки для эксперта или `null`, если вид верный. */
  validateTokenFormat?(token: string): string | null;

  /** Разбор вебхука. Проверяет секрет; неверный запрос — `{ kind: "rejected" }`. */
  parseWebhook(request: WebhookRequest, bot: BotCredentials): Promise<ParsedWebhook>;

  send(bot: BotCredentials, to: string, message: OutgoingMessage): Promise<SendResult>;
  answerButton?(bot: BotCredentials, callbackId: string): Promise<void>;

  entryLink(bot: { username: string; externalId: string }, code: string): string;
}

/** Адаптеры подключённых мессенджеров. Мессенджера без адаптера в приложении пока нет. */
export type ChannelAdapters = Partial<Record<ChannelKind, ChannelAdapter>>;
