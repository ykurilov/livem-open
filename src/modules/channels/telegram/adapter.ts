import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type {
  AttachmentKind,
  BotCredentials,
  BotIdentity,
  ChannelAdapter,
  ChannelEvent,
  ConnectionCheck,
  OutgoingMessage,
  ParsedWebhook,
  SendFailure,
  SendResult,
  WebhookRequest,
} from "../channel";
import { followUpChunks, splitText } from "../split-text";

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

export interface TelegramAdapterConfig {
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
/** Лимит Telegram на текст одного сообщения (считается по тексту без служебных знаков HTML). */
const MESSAGE_LIMIT = 4096;
/** Лимит Telegram на подпись к картинке; длиннее — текст уходит отдельным сообщением. */
const CAPTION_LIMIT = 1024;
const CALLBACK_DATA_LIMIT_BYTES = 64;
const DEFAULT_RETRY_AFTER_MS = 1000;
/** Telegram разрешает до 30 сообщений в секунду на бота; берём с запасом. */
const RATE_PER_SECOND = 25;
/** Токен от @BotFather: число, двоеточие, набор букв, цифр, «_» и «-». */
const TOKEN_FORMAT = /^\d+:[\w-]+$/;
const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"];

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

type ApiOutcome =
  | { ok: true; result: unknown }
  | { ok: false; status: number; description: string; retryAfterMs?: number };

export function createTelegramAdapter(config: TelegramAdapterConfig = {}): ChannelAdapter {
  const baseUrl = (config.apiBaseUrl ?? DEFAULT_TELEGRAM_API).replace(/\/+$/, "");
  const request = config.fetch ?? fetch;
  const timeoutMs = config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const proxyHeaders: Record<string, string> = config.proxyToken ? { "x-proxy-token": config.proxyToken } : {};

  async function call(token: string, method: string, body: object | FormData = {}): Promise<ApiOutcome> {
    const isUpload = body instanceof FormData;
    let response: Response;
    try {
      response = await request(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: isUpload ? proxyHeaders : { ...proxyHeaders, "content-type": "application/json" },
        body: isUpload ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Текст сетевой ошибки может содержать адрес запроса, а в нём токен
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, status: 0, description: `Не удалось связаться с Telegram: ${reason.replaceAll(token, "***")}` };
    }

    const payload = (await response.json().catch(() => null)) as TelegramResponse | null;
    if (response.ok && payload?.ok) return { ok: true, result: payload.result };
    const retryAfter = payload?.parameters?.retry_after;
    return {
      ok: false,
      status: response.status,
      description: payload?.description ?? `Telegram ответил ${response.status}`,
      ...(retryAfter !== undefined && { retryAfterMs: retryAfter * 1000 }),
    };
  }

  async function callOrThrow(token: string, method: string, body?: object): Promise<unknown> {
    const outcome = await call(token, method, body);
    if (!outcome.ok) throw new Error(outcome.description);
    return outcome.result;
  }

  return {
    kind: "telegram",
    ratePerSecond: RATE_PER_SECOND,

    validateTokenFormat(token) {
      return TOKEN_FORMAT.test(token)
        ? null
        : "Токен выглядит не так. Он состоит из цифр, двоеточия и букв, например 123456789:AAH-xyz_abc. Скопируйте его целиком из @BotFather.";
    },

    async verifyToken(token): Promise<BotIdentity> {
      const outcome = await call(token, "getMe");
      if (!outcome.ok) {
        // Telegram на неверный токен отвечает 401, а на токен неверной формы — 404
        if (outcome.status === 401 || outcome.status === 404) {
          throw new Error(`Неверный токен бота (Telegram ответил: ${outcome.description})`);
        }
        throw new Error(outcome.description);
      }
      const me = outcome.result as TelegramUser;
      return { externalId: String(me.id), username: me.username ?? "", title: me.first_name };
    },

    async findConflict(token, ownWebhookUrl) {
      const info = (await callOrThrow(token, "getWebhookInfo")) as { url?: string };
      if (info.url) {
        if (ownWebhookUrl && sameWebhook(info.url, ownWebhookUrl)) return null;
        return `Этот бот уже подключён к другому сервису (адрес: ${hostOf(info.url)}). Если подключить его здесь, тот сервис перестанет получать сообщения. Подключить всё равно?`;
      }
      // Вебхука нет, но бота может читать программа через getUpdates. Проба без offset: ничего не подтверждает, сообщения остаются у неё
      const probe = await call(token, "getUpdates", { timeout: 0, limit: 1 });
      if (probe.ok) return null;
      if (probe.status === 409) {
        return "Бот сейчас занят другой программой. Если подключить его здесь, она перестанет получать сообщения. Подключить всё равно?";
      }
      throw new Error(probe.description);
    },

    async connect(bot, webhookUrl) {
      await callOrThrow(bot.token, "setWebhook", {
        url: webhookUrl,
        secret_token: bot.webhookSecret,
        allowed_updates: ALLOWED_UPDATES,
      });
    },

    async disconnect(bot, webhookUrl) {
      // Адрес мог уже перейти к другому сервису: стираем только свой
      const info = (await callOrThrow(bot.token, "getWebhookInfo")) as { url?: string };
      if (info.url && sameWebhook(info.url, webhookUrl)) await callOrThrow(bot.token, "deleteWebhook");
    },

    async checkConnection(bot, webhookUrl): Promise<ConnectionCheck> {
      const outcome = await call(bot.token, "getMe");
      if (!outcome.ok) {
        // 401 и 404 — Telegram не знает этот токен (отозван, бот удалён); остальное — сбой по пути
        const kind = outcome.status === 401 || outcome.status === 404 ? "invalid_token" : "temporary";
        return { ok: false, kind, error: outcome.description };
      }
      if (!webhookUrl) return { ok: true };
      const webhook = await call(bot.token, "getWebhookInfo");
      if (!webhook.ok) return { ok: false, kind: "temporary", error: webhook.description };
      const current = (webhook.result as { url?: string }).url;
      // Адрес пустой или чужой: сообщения к нам уже не приходят
      if (!current || !sameWebhook(current, webhookUrl)) {
        return { ok: false, kind: "taken_over", error: "бота подключили к другому сервису" };
      }
      return { ok: true };
    },

    async parseWebhook(webhook, bot): Promise<ParsedWebhook> {
      if (!hasValidSecret(webhook, bot)) return { kind: "rejected" };
      let update: unknown;
      try {
        update = JSON.parse(webhook.body);
      } catch {
        return { kind: "rejected" };
      }
      if (typeof update !== "object" || update === null) return { kind: "rejected" };
      return { kind: "events", events: eventsFromUpdate(update as TelegramUpdate, bot.id), responseBody: "" };
    },

    async send(bot, to, message): Promise<SendResult> {
      const tooLong = message.buttons?.find((button) => Buffer.byteLength(button.payload) > CALLBACK_DATA_LIMIT_BYTES);
      if (tooLong) {
        return {
          ok: false,
          reason: "permanent",
          error: `Данные кнопки «${tooLong.label}» длиннее ${CALLBACK_DATA_LIMIT_BYTES} байт`,
        };
      }

      const markup = message.buttons && {
        inline_keyboard: message.buttons.map((button) => [{ text: button.label, callback_data: button.payload }]),
      };
      const text = message.text.trim() === "" ? "" : message.text;
      const imagePath = message.imagePath;
      const followUps = followUpChunks(message.followUps, MESSAGE_LIMIT);
      if (!text && !imagePath && followUps.length === 0) return { ok: false, reason: "empty" };

      // Сообщение — цепочка частей: картинка, затем текст кусками, затем дополнительные сообщения. Прогресс (`sentParts`) хранит вызывающий,
      // чтобы повтор после сбоя продолжил с места остановки, а не слал сначала.
      const parts: Array<() => Promise<SendResult>> = [];
      if (imagePath) {
        const captionFits = text.length <= CAPTION_LIMIT;
        const caption = captionFits && text ? text : undefined;
        parts.push(() => sendPhoto(bot, to, imagePath, caption, captionFits ? markup : undefined));
        if (!captionFits) parts.push(...textParts(bot, to, text, markup));
      } else if (text) {
        parts.push(...textParts(bot, to, text, markup));
      }
      parts.push(...followUps.map((chunk) => () => sendText(bot, to, chunk, undefined)));

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
      await callOrThrow(bot.token, "answerCallbackQuery", { callback_query_id: callbackId });
    },

    entryLink(bot, code) {
      return `https://t.me/${bot.username}?start=${code}`;
    },
  };

  /** Текст кусками не длиннее лимита; кнопки — на последнем куске. */
  function textParts(
    bot: BotCredentials,
    to: string,
    text: string,
    markup: object | undefined,
  ): Array<() => Promise<SendResult>> {
    const chunks = splitText(text, MESSAGE_LIMIT);
    return chunks.map((chunk, index) => () => sendText(bot, to, chunk, index === chunks.length - 1 ? markup : undefined));
  }

  async function sendText(bot: BotCredentials, to: string, text: string, markup: object | undefined): Promise<SendResult> {
    const outcome = await call(bot.token, "sendMessage", {
      chat_id: to,
      text: escapeHtml(text),
      parse_mode: "HTML",
      ...(markup && { reply_markup: markup }),
    });
    return toSendResult(outcome);
  }

  async function sendPhoto(
    bot: BotCredentials,
    to: string,
    imagePath: string,
    caption: string | undefined,
    markup: object | undefined,
  ): Promise<SendResult> {
    const captionFields = caption ? { caption: escapeHtml(caption), parse_mode: "HTML" } : {};

    if (/^https?:\/\//i.test(imagePath)) {
      return toSendResult(
        await call(bot.token, "sendPhoto", {
          chat_id: to,
          photo: imagePath,
          ...captionFields,
          ...(markup && { reply_markup: markup }),
        }),
      );
    }

    let file: Buffer;
    try {
      file = await readFile(imagePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: "permanent", error: `Не удалось прочитать картинку: ${reason}` };
    }
    const form = new FormData();
    form.set("chat_id", to);
    for (const [name, value] of Object.entries(captionFields)) form.set(name, value);
    if (markup) form.set("reply_markup", JSON.stringify(markup));
    const type = IMAGE_TYPES[extname(imagePath).toLowerCase()] ?? "application/octet-stream";
    form.set("photo", new Blob([new Uint8Array(file)], { type }), basename(imagePath));
    return toSendResult(await call(bot.token, "sendPhoto", form));
  }
}

/** Адрес вебхука наш, если совпадает путь: в нём id бота. Домен может поменяться вместе с пересылкой. */
function sameWebhook(actual: string, ours: string): boolean {
  try {
    return new URL(actual).pathname === new URL(ours).pathname;
  } catch {
    return false;
  }
}

/** Только домен: путь и параметры адреса могут содержать секреты чужого сервиса. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "неизвестен";
  }
}

function toSendResult(outcome: ApiOutcome): SendResult {
  if (outcome.ok) {
    const sent = outcome.result as { message_id: number };
    return { ok: true, externalMessageId: String(sent.message_id) };
  }
  if (outcome.status === 403) return { ok: false, reason: "blocked" };
  if (outcome.status === 429) {
    return { ok: false, reason: "rate_limited", retryAfterMs: outcome.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS };
  }
  // 0 — сеть не ответила; 5xx — сбой Telegram или нашего прокси: повторим позже
  if (outcome.status === 0 || outcome.status >= 500) return { ok: false, reason: "temporary", error: outcome.description };
  return { ok: false, reason: "permanent", error: outcome.description };
}

/** Текст сообщений — простой; служебные знаки HTML экранируем, ссылки Telegram подсвечивает сам. */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function hasValidSecret(webhook: WebhookRequest, bot: BotCredentials): boolean {
  const given = webhook.headers[TELEGRAM_SECRET_HEADER];
  if (typeof given !== "string") return false;
  // Сравнение по хешам: одинаковая длина и время не зависит от того, сколько знаков совпало
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(bot.webhookSecret));
}

// --- разбор обновлений ---

interface TelegramResponse {
  ok?: boolean;
  result?: unknown;
  description?: string;
  parameters?: { retry_after?: number };
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type?: string;
}

interface TelegramMessage {
  from?: TelegramUser;
  chat?: TelegramChat;
  text?: string;
  caption?: string;
  [mediaKey: string]: unknown;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; from?: TelegramUser; data?: string; message?: TelegramMessage };
  my_chat_member?: {
    chat?: TelegramChat;
    old_chat_member?: { status?: string };
    new_chat_member?: { status?: string };
  };
}

const START_COMMAND = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/;

function eventsFromUpdate(update: TelegramUpdate, botId: string): ChannelEvent[] {
  const dedupeKey = `telegram:${botId}:${update.update_id}`;

  const message = update.message;
  if (message?.chat?.type === "private" && message.from && !message.from.is_bot) {
    const text = message.text ?? message.caption ?? "";
    const attachment = attachmentOf(message);
    // Служебные сообщения без текста и вложения (закрепили, сменили фото) — не разговор
    if (!text && !attachment) return [];
    const startCode = message.text ? START_COMMAND.exec(message.text)?.[1] : undefined;
    const userName = displayName(message.from);
    return [
      {
        type: "message",
        dedupeKey,
        userId: String(message.from.id),
        ...(userName && { userName }),
        text,
        ...(attachment && { attachment }),
        ...(startCode && { startCode }),
      },
    ];
  }

  const button = update.callback_query;
  if (button?.from && (button.message?.chat?.type ?? "private") === "private") {
    return [
      { type: "button", dedupeKey, userId: String(button.from.id), callbackId: button.id, payload: button.data ?? "" },
    ];
  }

  const membership = update.my_chat_member;
  if (membership?.chat?.type === "private") {
    const userId = String(membership.chat.id);
    const before = membership.old_chat_member?.status;
    const after = membership.new_chat_member?.status;
    if (after === "kicked") return [{ type: "blocked", dedupeKey, userId }];
    if (before === "kicked" && after === "member") return [{ type: "unblocked", dedupeKey, userId }];
  }

  return [];
}

function displayName(user: TelegramUser): string | undefined {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return fullName || user.username || undefined;
}

function attachmentOf(message: TelegramMessage): AttachmentKind | undefined {
  if (message.photo) return "image";
  if (message.voice || message.video_note) return "voice";
  if (message.sticker) return "sticker";
  if (message.document || message.audio) return "file";
  const otherMedia = ["video", "animation", "location", "venue", "contact", "poll", "dice"];
  return otherMedia.some((key) => message[key] !== undefined) ? "other" : undefined;
}
