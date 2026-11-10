// Общий интерфейс мессенджера. Остальной код знает только эти типы (конституция II).

import type { ImageLoadResult } from "./image-source";

/** `web` — веб-чат лидмагнита на нашей странице `/c/<код>`: без мессенджера и без бота эксперта. */
export type ChannelKind = "telegram" | "vk" | "max" | "web";

export const CHANNEL_LABELS: Record<ChannelKind, string> = { telegram: "Telegram", vk: "ВКонтакте", max: "Max", web: "Веб-чат" };

/** Мессенджеры, к которым эксперт подключает своих ботов. Веб-чат есть у каждого опубликованного лидмагнита сам. */
export const MESSENGER_KINDS = ["telegram", "vk", "max"] as const satisfies readonly ChannelKind[];

/** Всё, что адаптеру нужно знать о боте. Токен здесь уже расшифрован. */
export interface BotCredentials {
  id: string;
  token: string;
  externalId: string;
  username: string;
  webhookSecret: string;
  /** `false` — ключ бота без права на картинки (ВК без «Фотографии»): картинки не отправляем, сообщение уходит текстом. */
  canSendPhotos?: boolean;
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
      /** Фото или снимок экрана: ссылка, по которой адаптер потом скачает байты (`downloadImage`). Telegram — file_id, Max и ВК — адрес. */
      imageRef?: string;
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
  /**
   * Готовые ответы человека: нажатие отправляет текст кнопки обычным сообщением. Висят под последней частью сообщения.
   * Пустой список — у прошлого сообщения были, а у этого нет: адаптер убирает их, где мессенджер держит их сам.
   */
  quickReplies?: string[];
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
  /** У ключа бота нет права на картинки (ВК: «Фотографии»). Ничего не ушло: сообщение можно отправить без картинки. */
  | { reason: "photos_not_allowed" }
) & { ok: false; sentParts?: number };

export type SendResult = { ok: true; externalMessageId: string } | SendFailure;

/**
 * Итог проверки бота. `invalid_token` — токен отозван или бота нет: чинить нужно человеку.
 * `taken_over` — наш приём сообщений заняли: бота подключили к другому сервису. Само не пройдёт.
 * `temporary` — сеть, прокси или ограничение скорости: может пройти само.
 */
export type ConnectionCheck = { ok: true } | { ok: false; kind: ConnectionFailureKind; error: string };
export type ConnectionFailureKind = "invalid_token" | "taken_over" | "temporary";

export interface BotIdentity {
  externalId: string;
  username: string;
  title: string;
  /** `false` — ключ без права на картинки (ВК). Нет поля — мессенджер картинкам не мешает. */
  canSendPhotos?: boolean;
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
  /** Байты фото клиента по ссылке из события (`imageRef`). Не бросает исключений: сбой — в результате, без токена в тексте. */
  downloadImage?(bot: BotCredentials, ref: string): Promise<ImageLoadResult>;
  answerButton?(bot: BotCredentials, callbackId: string): Promise<void>;

  entryLink(bot: { username: string; externalId: string }, code: string): string;
}

/** Адаптеры подключённых мессенджеров. Мессенджера без адаптера в приложении пока нет. */
export type ChannelAdapters = Partial<Record<ChannelKind, ChannelAdapter>>;
