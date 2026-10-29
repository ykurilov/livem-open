import type {
  AttachmentKind,
  BotCredentials,
  BotIdentity,
  ChannelAdapter,
  ChannelEvent,
  ConnectionCheck,
  OutgoingMessage,
  ParsedWebhook,
  SendResult,
} from "../channel";
import { isImageLink, loadImage } from "../image-source";
import { followUpChunks, splitText } from "../split-text";
import { alphanumericSecret, secretsMatch } from "../webhook-secret";

export const MAX_SECRET_HEADER = "x-max-bot-api-secret";

export interface MaxAdapterConfig {
  /** Адрес Bot API. */
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  /** Сколько ждать ответа Max, мс. Нужен тестам; по умолчанию 15 секунд. */
  requestTimeoutMs?: number;
}

const DEFAULT_MAX_API = "https://platform-api.max.ru";
const REQUEST_TIMEOUT_MS = 15_000;
/** Лимит Max на текст одного сообщения. */
const MESSAGE_LIMIT = 4000;
const BUTTON_PAYLOAD_LIMIT = 1024;
const DEFAULT_RETRY_AFTER_MS = 1000;
/** Max разрешает до 30 запросов в секунду на бота; берём с запасом. */
const RATE_PER_SECOND = 25;
const UPDATE_TYPES = ["bot_started", "bot_stopped", "message_created", "message_callback"];
/** Коды 403, при которых человек остановил бота или удалил диалог. Прочие 403 — проблема бота, а не человека. */
const BLOCKED_CODES = new Set(["chat.denied", "dialog.suspended", "dialog.removed"]);
const NOT_READY_CODE = "attachment.not.ready";
/** Сколько помним токен загруженной картинки: хватает на повторы с паузами до 10 минут. */
const UPLOADED_IMAGE_TTL_MS = 15 * 60_000;

type ApiOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; code?: string; description: string; retryAfterMs?: number };

interface CallOptions {
  query?: Record<string, string>;
  body?: object;
}

export function createMaxAdapter(config: MaxAdapterConfig = {}): ChannelAdapter {
  const baseUrl = (config.apiBaseUrl ?? DEFAULT_MAX_API).replace(/\/+$/, "");
  const request = config.fetch ?? fetch;
  const timeoutMs = config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  /** Токены картинок, которые Max принял, но ещё обрабатывает: нужны повтору отправки. Ключ — бот и ключ повтора. */
  const uploadedImages = new Map<string, { token: string; expiresAt: number }>();

  async function call(token: string, httpMethod: string, path: string, options: CallOptions = {}): Promise<ApiOutcome> {
    const query = options.query ? `?${new URLSearchParams(options.query)}` : "";
    let response: Response;
    try {
      response = await request(`${baseUrl}${path}${query}`, {
        method: httpMethod,
        headers: {
          authorization: token,
          ...(options.body && { "content-type": "application/json" }),
        },
        body: options.body && JSON.stringify(options.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, status: 0, description: `Не удалось связаться с Max: ${withoutToken(reasonOf(error), token)}` };
    }

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok) return { ok: true, data: payload ?? {} };
    const retryAfter = Number(response.headers.get("retry-after"));
    const message = typeof payload?.message === "string" ? payload.message : `Max ответил ${response.status}`;
    return {
      ok: false,
      status: response.status,
      ...(typeof payload?.code === "string" && { code: payload.code }),
      description: withoutToken(message, token),
      ...(retryAfter > 0 && { retryAfterMs: retryAfter * 1000 }),
    };
  }

  async function callOrThrow(token: string, httpMethod: string, path: string, options?: CallOptions) {
    const outcome = await call(token, httpMethod, path, options);
    if (!outcome.ok) throw new Error(outcome.description);
    return outcome.data;
  }

  return {
    kind: "max",
    ratePerSecond: RATE_PER_SECOND,

    async verifyToken(token): Promise<BotIdentity> {
      const outcome = await call(token, "GET", "/me");
      if (!outcome.ok) {
        if (outcome.status === 401) throw new Error(`Неверный токен бота (Max ответил: ${outcome.description})`);
        throw new Error(outcome.description);
      }
      const me = outcome.data as unknown as MaxUser;
      return { externalId: String(me.user_id), username: me.username ?? "", title: me.name ?? me.first_name };
    },

    async connect(bot, webhookUrl) {
      const result = await callOrThrow(bot.token, "POST", "/subscriptions", {
        body: { url: webhookUrl, update_types: UPDATE_TYPES, secret: alphanumericSecret(bot.webhookSecret) },
      });
      if (result.success === false) {
        throw new Error(typeof result.message === "string" ? result.message : "Max не принял адрес вебхука");
      }
    },

    async disconnect(bot, webhookUrl) {
      // Идентификатора подписки у Max нет: подписка живёт по адресу. Сравниваем адрес целиком, чужие не трогаем
      const { subscriptions } = (await callOrThrow(bot.token, "GET", "/subscriptions")) as { subscriptions?: Array<{ url: string }> };
      if ((subscriptions ?? []).some((subscription) => subscription.url === webhookUrl)) {
        await callOrThrow(bot.token, "DELETE", "/subscriptions", { query: { url: webhookUrl } });
      }
    },

    async checkConnection(bot): Promise<ConnectionCheck> {
      const outcome = await call(bot.token, "GET", "/me");
      if (outcome.ok) return { ok: true };
      return { ok: false, kind: outcome.status === 401 ? "invalid_token" : "temporary", error: outcome.description };
    },

    async parseWebhook(webhook, bot): Promise<ParsedWebhook> {
      if (!secretsMatch(webhook.headers[MAX_SECRET_HEADER], alphanumericSecret(bot.webhookSecret))) {
        return { kind: "rejected" };
      }
      let update: unknown;
      try {
        update = JSON.parse(webhook.body);
      } catch {
        return { kind: "rejected" };
      }
      if (typeof update !== "object" || update === null || Array.isArray(update)) return { kind: "rejected" };
      return { kind: "events", events: eventsFromUpdate(update as MaxUpdate, bot.id), responseBody: "" };
    },

    async send(bot, to, message): Promise<SendResult> {
      const tooLong = message.buttons?.find((button) => button.payload.length > BUTTON_PAYLOAD_LIMIT);
      if (tooLong) {
        return {
          ok: false,
          reason: "permanent",
          error: `Данные кнопки «${tooLong.label}» длиннее ${BUTTON_PAYLOAD_LIMIT} знаков`,
        };
      }
      const keyboard = message.buttons && {
        type: "inline_keyboard",
        payload: {
          buttons: message.buttons.map((button) => [{ type: "callback", text: button.label, payload: button.payload }]),
        },
      };
      const text = message.text.trim() === "" ? "" : message.text;
      const followUps = followUpChunks(message.followUps, MESSAGE_LIMIT);
      if (!text && !message.imagePath && followUps.length === 0) return { ok: false, reason: "empty" };

      // Сообщение — цепочка частей: текст кусками с картинкой в первом, затем дополнительные сообщения. Прогресс (`sentParts`) хранит вызывающий,
      // чтобы повтор после сбоя продолжил с места остановки, а не слал сначала.
      const chunks = text ? splitText(text, MESSAGE_LIMIT) : message.imagePath ? [""] : [];
      const uploadKey = `${bot.id}:${message.idempotencyKey}`;
      const parts = [...chunks, ...followUps].map((chunk, index) => async (): Promise<SendResult> => {
        const attachments: object[] = [];
        let uploadedToken: string | undefined;
        if (index === 0 && message.imagePath) {
          const image = await imageAttachment(bot, message.imagePath, uploadKey);
          if (!image.ok) return image.failure;
          attachments.push(image.attachment);
          uploadedToken = image.uploadedToken;
        }
        if (index === chunks.length - 1 && keyboard) attachments.push(keyboard);
        const { result, notReady } = await sendMessage(bot, to, chunk, attachments);
        // Max ещё обрабатывает картинку: токен нужен повтору. Любой другой исход — токен больше не нужен
        if (uploadedToken) {
          if (notReady) {
            const now = Date.now();
            for (const [key, entry] of uploadedImages) if (entry.expiresAt <= now) uploadedImages.delete(key);
            uploadedImages.set(uploadKey, { token: uploadedToken, expiresAt: now + UPLOADED_IMAGE_TTL_MS });
          } else {
            uploadedImages.delete(uploadKey);
          }
        }
        return result;
      });

      // Прогресс больше числа частей — значит, он потерян или устарел: лучше повторить последнюю часть, чем потерять
      const first = Math.min(Math.max(message.sentParts ?? 0, 0), parts.length - 1);
      let last: SendResult = { ok: false, reason: "empty" };
      for (let index = first; index < parts.length; index += 1) {
        last = await parts[index]!();
        if (last.ok) continue;
        // Прогресс нужен тем, кого будут повторять: после временного сбоя или после починки бота
        const retryable = last.reason === "rate_limited" || last.reason === "temporary" || last.reason === "permanent";
        return retryable && last.sentParts === undefined ? { ...last, sentParts: index } : last;
      }
      return last;
    },

    async answerButton(bot, callbackId) {
      await callOrThrow(bot.token, "POST", "/answers", { query: { callback_id: callbackId }, body: {} });
    },

    entryLink(bot, code) {
      return `https://max.ru/${bot.username}?start=${code}`;
    },
  };

  // У Max нет ключа защиты от дублей (как `random_id` у ВК). Если сообщение дошло, а ответ потерялся
  // (таймаут, обрыв сети), результат будет temporary и повтор отправит то же сообщение ещё раз:
  // возможен редкий дубль. Это осознанная цена; повтор без него потерял бы сообщения.
  async function sendMessage(
    bot: BotCredentials,
    to: string,
    text: string,
    attachments: object[],
  ): Promise<{ result: SendResult; notReady: boolean }> {
    const outcome = await call(bot.token, "POST", "/messages", {
      query: { user_id: to },
      body: { ...(text && { text }), ...(attachments.length > 0 && { attachments }) },
    });
    if (outcome.ok) {
      const sent = outcome.data as { message?: { body?: { mid?: string } } };
      return { result: { ok: true, externalMessageId: sent.message?.body?.mid ?? "" }, notReady: false };
    }
    return { result: toFailure(outcome), notReady: outcome.code === NOT_READY_CODE };
  }

  /** Картинка по ссылке уходит ссылкой; файл сначала загружается в Max и уходит токеном. */
  async function imageAttachment(
    bot: BotCredentials,
    imagePath: string,
    uploadKey: string,
  ): Promise<{ ok: true; attachment: object; uploadedToken?: string } | { ok: false; failure: SendResult }> {
    if (isImageLink(imagePath)) return { ok: true, attachment: { type: "image", payload: { url: imagePath } } };

    // Повтор после attachment.not.ready: картинка уже в Max, второй раз её не загружаем
    const remembered = uploadedImages.get(uploadKey);
    if (remembered && remembered.expiresAt > Date.now()) {
      return { ok: true, attachment: { type: "image", payload: { token: remembered.token } }, uploadedToken: remembered.token };
    }

    const loaded = await loadImage(imagePath, request, timeoutMs);
    if (!loaded.ok) return { ok: false, failure: { ok: false, reason: loaded.reason, error: loaded.error } };

    const slot = await call(bot.token, "POST", "/uploads", { query: { type: "image" } });
    if (!slot.ok) return { ok: false, failure: toFailure(slot) };

    const form = new FormData();
    form.set("data", new Blob([loaded.image.bytes as BlobPart], { type: loaded.image.contentType }), loaded.image.filename);
    let response: Response;
    try {
      response = await request(String(slot.data.url), { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return {
        ok: false,
        failure: { ok: false, reason: "temporary", error: `Не удалось загрузить картинку в Max: ${withoutToken(reasonOf(error), bot.token)}` },
      };
    }
    const uploaded = (await response.json().catch(() => null)) as { photos?: Record<string, { token?: string }> } | null;
    const token = Object.values(uploaded?.photos ?? {})[0]?.token;
    if (!response.ok || !token) {
      const reason = response.status >= 500 || response.ok ? "temporary" : "permanent";
      return {
        ok: false,
        failure: { ok: false, reason, error: `Max не принял картинку (ответ ${response.status})` },
      };
    }
    return { ok: true, attachment: { type: "image", payload: { token } }, uploadedToken: token };
  }
}

function toFailure(outcome: Extract<ApiOutcome, { ok: false }>): SendResult {
  if (outcome.status === 403 && outcome.code && BLOCKED_CODES.has(outcome.code)) return { ok: false, reason: "blocked" };
  if (outcome.status === 429) {
    return { ok: false, reason: "rate_limited", retryAfterMs: outcome.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS };
  }
  // Картинка загружена, но Max ещё её обрабатывает: подождём и повторим
  if (outcome.code === NOT_READY_CODE) return { ok: false, reason: "temporary", error: outcome.description };
  // 0 — сеть не ответила; 5xx — сбой Max: повторим позже
  if (outcome.status === 0 || outcome.status >= 500) return { ok: false, reason: "temporary", error: outcome.description };
  return { ok: false, reason: "permanent", error: outcome.description };
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
// Текст ошибки может содержать токен (адрес запроса, ответ Max): в журнал и интерфейс он не попадает
const withoutToken = (text: string, token: string) => text.replaceAll(token, "***");

// --- разбор обновлений ---

interface MaxUser {
  user_id: number;
  first_name: string;
  last_name?: string;
  name?: string;
  username?: string;
  is_bot?: boolean;
}

interface MaxUpdate {
  update_type: string;
  timestamp: number;
  user?: MaxUser;
  payload?: string;
  callback?: { callback_id: string; payload?: string; user?: MaxUser };
  message?: {
    sender?: MaxUser;
    recipient?: { chat_type?: string };
    body?: { mid?: string; text?: string | null; attachments?: Array<{ type: string }> };
  };
}

function eventsFromUpdate(update: MaxUpdate, botId: string): ChannelEvent[] {
  const keyOf = (type: string, userId: string) => `max:${botId}:${type}:${userId}:${update.timestamp}`;

  if (update.update_type === "bot_started" && update.user) {
    const userId = String(update.user.user_id);
    const startCode = update.payload || undefined;
    return [
      {
        type: "message",
        dedupeKey: keyOf("bot_started", userId),
        userId,
        ...nameOf(update.user),
        text: startCode ? `/start ${startCode}` : "/start",
        ...(startCode && { startCode }),
      },
    ];
  }

  if (update.update_type === "bot_stopped" && update.user) {
    const userId = String(update.user.user_id);
    return [{ type: "blocked", dedupeKey: keyOf("bot_stopped", userId), userId }];
  }

  if (update.update_type === "message_created") {
    const message = update.message;
    if (message?.recipient?.chat_type !== "dialog" || !message.sender || message.sender.is_bot) return [];
    const text = message.body?.text ?? "";
    const attachment = attachmentOf(message.body?.attachments);
    // Служебные сообщения без текста и вложения — не разговор
    if (!text && !attachment) return [];
    const userId = String(message.sender.user_id);
    const mid = message.body?.mid;
    return [
      {
        type: "message",
        dedupeKey: mid ? `max:${botId}:${mid}` : keyOf("message_created", userId),
        userId,
        ...nameOf(message.sender),
        text,
        ...(attachment && { attachment }),
      },
    ];
  }

  if (update.update_type === "message_callback" && update.callback?.user) {
    const { callback_id, payload, user } = update.callback;
    return [
      { type: "button", dedupeKey: `max:${botId}:${callback_id}`, userId: String(user.user_id), callbackId: callback_id, payload: payload ?? "" },
    ];
  }

  return [];
}

function nameOf(user: MaxUser): { userName?: string } {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const userName = fullName || user.name || user.username;
  return userName ? { userName } : {};
}

function attachmentOf(attachments: Array<{ type: string }> | undefined): AttachmentKind | undefined {
  // `share` — карточка-превью, которую Max сам добавляет к ссылке в тексте: это не вложение человека
  const type = attachments?.find((attachment) => attachment.type !== "share")?.type;
  if (!type) return undefined;
  if (type === "image") return "image";
  if (type === "audio") return "voice";
  if (type === "sticker") return "sticker";
  if (type === "file") return "file";
  return "other";
}
