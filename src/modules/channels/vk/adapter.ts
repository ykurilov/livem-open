import { createHash } from "node:crypto";
import type {
  AttachmentKind,
  BotCredentials,
  BotIdentity,
  ChannelAdapter,
  ChannelEvent,
  ConnectionCheck,
  ParsedWebhook,
  SendResult,
} from "../channel";
import { loadImage } from "../image-source";
import { followUpChunks, splitText } from "../split-text";
import { alphanumericSecret, secretsMatch } from "../webhook-secret";

export const VK_API_VERSION = "5.199";

export interface VkAdapterConfig {
  /** Адрес методов API. */
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  /** Сколько ждать ответа ВК, мс. Нужен тестам; по умолчанию 15 секунд. */
  requestTimeoutMs?: number;
}

const DEFAULT_VK_API = "https://api.vk.com";
const REQUEST_TIMEOUT_MS = 15_000;
/** Лимит ВК на текст одного сообщения. */
const MESSAGE_LIMIT = 4096;
const BUTTON_LABEL_LIMIT = 40;
const BUTTON_PAYLOAD_LIMIT_BYTES = 255;
const DEFAULT_RETRY_AFTER_MS = 1000;
/** ВК разрешает сообществу до 20 сообщений в секунду; берём с запасом. */
const RATE_PER_SECOND = 15;
/** ВК принимает в секрете сервера не больше 50 знаков. */
const SECRET_LIMIT = 50;
// ВК: название Callback-сервера — не длиннее 14 букв
const SERVER_TITLE = "Лидмагниты";

// Коды ошибок ВК
const ERROR_INVALID_TOKEN = 5;
const ERROR_TOO_MANY_PER_SECOND = 6;
const ERROR_BAD_PARAMETER = 100;
const ERROR_METHOD_LIMIT = 29;
const ERROR_ACCESS_DENIED = 15;
const TEMPORARY_CODES = new Set([1, 9, 10, ERROR_METHOD_LIMIT]);
const TOKEN_REJECTED_CODES = new Set([ERROR_INVALID_TOKEN, 27, 28]);
/**
 * Сообщество не может писать этому человеку: в чёрном списке сообщества (900), не разрешил сообщения (901)
 * или закрыл их настройками приватности (902). Коды 917 и 925 — про беседы (нет доступа, не админ): мы пишем
 * только в личные, человек тут ни при чём, поэтому это обычная постоянная ошибка.
 */
const BLOCKED_CODES = new Set([900, 901, 902]);
/** «Can't send message, reply timed out»: окно для ответа человеку закрыто. Писать первым нельзя, пока человек не напишет сам. */
const REPLY_WINDOW_CLOSED_CODE = 950;

const MANAGE_RIGHT = "Управление сообществом";
/** Права ключа сообщества, без которых бот не работает (биты маски ВК): сервер событий, сообщения, картинки. */
const REQUIRED_RIGHTS = [
  { bit: 262144, name: MANAGE_RIGHT },
  { bit: 4096, name: "Сообщения сообщества" },
  { bit: 4, name: "Фотографии" },
] as const;

const missingRightsError = (names: readonly string[]) =>
  new Error(
    `${names.map((name) => `У ключа нет права «${name}»`).join(". ")}. Создайте в сообществе новый ключ доступа и отметьте права ${REQUIRED_RIGHTS.map((right) => `«${right.name}»`).join(", ")}.`,
  );

type ApiOutcome =
  | { ok: true; response: unknown }
  | { ok: false; status: number; code?: number; description: string };

export interface VkAdapter extends ChannelAdapter {
  /** Номера Callback-серверов сообщества с этим адресом (адрес сравнивается целиком). */
  callbackServerIds(bot: BotCredentials, webhookUrl: string): Promise<number[]>;
}

export function createVkAdapter(config: VkAdapterConfig = {}): VkAdapter {
  const baseUrl = (config.apiBaseUrl ?? DEFAULT_VK_API).replace(/\/+$/, "");
  const request = config.fetch ?? fetch;
  const timeoutMs = config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  async function call(token: string, method: string, params: Record<string, string | number> = {}): Promise<ApiOutcome> {
    const form = new URLSearchParams({ access_token: token, v: VK_API_VERSION });
    for (const [name, value] of Object.entries(params)) form.set(name, String(value));

    let response: Response;
    try {
      response = await request(`${baseUrl}/method/${method}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, status: 0, description: `Не удалось связаться с ВК: ${withoutToken(reasonOf(error), token)}` };
    }

    const payload = (await response.json().catch(() => null)) as VkResponse | null;
    if (payload?.error) {
      return {
        ok: false,
        status: response.status,
        code: payload.error.error_code,
        description: withoutToken(payload.error.error_msg ?? `ВК вернул ошибку ${payload.error.error_code}`, token),
      };
    }
    if (!response.ok || !payload) return { ok: false, status: response.status, description: `ВК ответил ${response.status}` };
    return { ok: true, response: payload.response };
  }

  async function callOrThrow(token: string, method: string, params?: Record<string, string | number>): Promise<unknown> {
    const outcome = await call(token, method, params);
    if (!outcome.ok) throw new Error(outcome.description);
    return outcome.response;
  }

  /** Настройка сервера событий: ей нужно право «Управление сообществом», отказ в доступе — значит его нет. */
  async function callServerSetup(token: string, method: string, params?: Record<string, string | number>): Promise<unknown> {
    const outcome = await call(token, method, params);
    if (!outcome.ok) throw outcome.code === ERROR_ACCESS_DENIED ? missingRightsError([MANAGE_RIGHT]) : new Error(outcome.description);
    return outcome.response;
  }

  /** Серверы сообщества с этим адресом: адрес сравниваем целиком, чужие серверы не трогаем. */
  async function serversAt(bot: BotCredentials, webhookUrl: string): Promise<Array<{ id: number; url: string }>> {
    const result = (await callServerSetup(bot.token, "groups.getCallbackServers", { group_id: bot.externalId })) as {
      items?: Array<{ id: number; url: string }>;
    };
    return (result.items ?? []).filter((server) => server.url === webhookUrl);
  }

  return {
    kind: "vk",
    ratePerSecond: RATE_PER_SECOND,

    async verifyToken(token): Promise<BotIdentity> {
      const outcome = await call(token, "groups.getById");
      if (!outcome.ok) {
        if (outcome.code === ERROR_INVALID_TOKEN) throw new Error(`Неверный ключ доступа сообщества (ВК ответил: ${outcome.description})`);
        // Личный токен вместо ключа сообщества: ВК не понимает, о каком сообществе речь
        if (outcome.code === ERROR_BAD_PARAMETER) {
          throw new Error(`Нужен ключ сообщества, а не личный токен: создайте ключ доступа в настройках сообщества (ВК ответил: ${outcome.description})`);
        }
        throw new Error(outcome.description);
      }
      // Новые версии API отдают {groups: [...]}, старые — просто массив
      const answer = outcome.response as VkGroup[] | { groups?: VkGroup[] };
      const group = (Array.isArray(answer) ? answer : answer.groups)?.[0];
      if (!group) throw new Error("ВК не вернул данные сообщества: проверьте ключ доступа");
      // Права ключа — до подключения: иначе сервер событий не настроится или ответы не уйдут. Не ответил ВК — решит connect
      const rights = await call(token, "groups.getTokenPermissions");
      const mask = rights.ok ? (rights.response as { mask?: unknown }).mask : undefined;
      if (typeof mask === "number") {
        const missing = REQUIRED_RIGHTS.filter((right) => (mask & right.bit) === 0).map((right) => right.name);
        if (missing.length > 0) throw missingRightsError(missing);
      }
      return { externalId: String(group.id), username: group.screen_name ?? "", title: group.name };
    },

    async connect(bot, webhookUrl) {
      // Повторное подключение: старый сервер с тем же адресом убираем, чтобы события не приходили дважды
      for (const server of await serversAt(bot, webhookUrl)) {
        await callServerSetup(bot.token, "groups.deleteCallbackServer", { group_id: bot.externalId, server_id: server.id });
      }
      // ВК во время этого вызова шлёт на адрес запрос `confirmation` — его обрабатывает parseWebhook
      const added = (await callServerSetup(bot.token, "groups.addCallbackServer", {
        group_id: bot.externalId,
        url: webhookUrl,
        title: SERVER_TITLE,
        secret_key: vkSecret(bot),
      })) as { server_id: number };
      await callServerSetup(bot.token, "groups.setCallbackSettings", {
        group_id: bot.externalId,
        server_id: added.server_id,
        api_version: VK_API_VERSION,
        message_new: 1,
        message_allow: 1,
        message_deny: 1,
        message_event: 1,
      });
    },

    async disconnect(bot, webhookUrl) {
      for (const server of await serversAt(bot, webhookUrl)) {
        await callServerSetup(bot.token, "groups.deleteCallbackServer", { group_id: bot.externalId, server_id: server.id });
      }
    },

    async callbackServerIds(bot, webhookUrl) {
      return (await serversAt(bot, webhookUrl)).map((server) => server.id);
    },

    async checkConnection(bot): Promise<ConnectionCheck> {
      const outcome = await call(bot.token, "groups.getById");
      if (outcome.ok) return { ok: true };
      const kind = outcome.code !== undefined && TOKEN_REJECTED_CODES.has(outcome.code) ? "invalid_token" : "temporary";
      return { ok: false, kind, error: outcome.description };
    },

    async parseWebhook(webhook, bot): Promise<ParsedWebhook> {
      let update: unknown;
      try {
        update = JSON.parse(webhook.body);
      } catch {
        return { kind: "rejected" };
      }
      if (typeof update !== "object" || update === null || Array.isArray(update)) return { kind: "rejected" };
      const event = update as VkCallbackEvent;
      if (String(event.group_id) !== bot.externalId) return { kind: "rejected" };

      if (event.type === "confirmation") {
        // Секрет мы задаём сами при addCallbackServer, поэтому требуем его и здесь: без него код подтверждения
        // не выдаём. Если на живой проверке ВК окажется, что в `confirmation` секрет не приходит, правило
        // придётся пересмотреть (обсудить отдельно), а не молча ослаблять.
        if (!secretsMatch(event.secret, vkSecret(bot))) return { kind: "rejected" };
        const outcome = await call(bot.token, "groups.getCallbackConfirmationCode", { group_id: bot.externalId });
        // Не получили код — отказываем понятным ответом (не 500); ВК повторит запрос или покажет, что адрес не подтверждён
        if (!outcome.ok) return { kind: "rejected" };
        return { kind: "handshake", responseBody: (outcome.response as { code: string }).code };
      }

      if (!secretsMatch(event.secret, vkSecret(bot))) return { kind: "rejected" };
      return { kind: "events", events: eventsFromCallback(event, bot.id), responseBody: "ok" };
    },

    async send(bot, to, message): Promise<SendResult> {
      const tooLong = message.buttons?.find((button) => button.label.length > BUTTON_LABEL_LIMIT);
      if (tooLong) {
        return { ok: false, reason: "permanent", error: `Надпись на кнопке «${tooLong.label}» длиннее ${BUTTON_LABEL_LIMIT} знаков` };
      }
      const buttons = message.buttons?.map((button) => ({ label: button.label, payload: JSON.stringify({ p: button.payload }) }));
      const overweight = buttons?.find((button) => Buffer.byteLength(button.payload) > BUTTON_PAYLOAD_LIMIT_BYTES);
      if (overweight) {
        return { ok: false, reason: "permanent", error: `Данные кнопки «${overweight.label}» длиннее ${BUTTON_PAYLOAD_LIMIT_BYTES} байт` };
      }
      const keyboard =
        buttons &&
        JSON.stringify({
          inline: true,
          buttons: buttons.map((button) => [{ action: { type: "callback", label: button.label, payload: button.payload } }]),
        });

      const text = message.text.trim() === "" ? "" : message.text;
      const followUps = followUpChunks(message.followUps, MESSAGE_LIMIT);
      if (!text && !message.imagePath && followUps.length === 0) return { ok: false, reason: "empty" };

      // Сообщение — цепочка частей: текст кусками с картинкой в первом, затем дополнительные сообщения. Прогресс (`sentParts`) хранит вызывающий,
      // чтобы повтор после сбоя продолжил с места остановки, а не слал сначала.
      const chunks = text ? splitText(text, MESSAGE_LIMIT) : message.imagePath ? [""] : [];
      const parts = [...chunks, ...followUps].map((chunk, index) => async (): Promise<SendResult> => {
        let attachment: string | undefined;
        if (index === 0 && message.imagePath) {
          const photo = await uploadPhoto(bot, to, message.imagePath);
          if (!photo.ok) return photo.failure;
          attachment = photo.attachment;
        }
        const outcome = await call(bot.token, "messages.send", {
          peer_id: to,
          random_id: randomIdFor(message.idempotencyKey, index),
          ...(chunk && { message: chunk }),
          ...(attachment && { attachment }),
          ...(index === chunks.length - 1 && keyboard && { keyboard }),
        });
        if (!outcome.ok) return toFailure(outcome);
        return { ok: true, externalMessageId: String(outcome.response) };
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
      // Идентификатор нажатия мы собрали сами (см. eventsFromCallback): человек | диалог | событие
      const [userId, peerId, ...rest] = callbackId.split("|");
      const eventId = rest.join("|");
      if (!userId || !peerId || !eventId) throw new Error("Непонятный идентификатор нажатия кнопки");
      await callOrThrow(bot.token, "messages.sendMessageEventAnswer", { event_id: eventId, user_id: userId, peer_id: peerId });
    },

    entryLink(bot, code) {
      return `https://vk.me/${bot.username || `club${bot.externalId}`}?ref=${code}&ref_source=${code}`;
    },
  };

  /** ВК не берёт картинку по ссылке: файл скачивается (или читается), загружается на сервер ВК и сохраняется. */
  async function uploadPhoto(
    bot: BotCredentials,
    to: string,
    imagePath: string,
  ): Promise<{ ok: true; attachment: string } | { ok: false; failure: SendResult }> {
    const loaded = await loadImage(imagePath, request, timeoutMs);
    if (!loaded.ok) return { ok: false, failure: { ok: false, reason: loaded.reason, error: loaded.error } };

    const server = await call(bot.token, "photos.getMessagesUploadServer", { peer_id: to });
    if (!server.ok) return { ok: false, failure: toFailure(server) };

    const form = new FormData();
    form.set("photo", new Blob([loaded.image.bytes as BlobPart], { type: loaded.image.contentType }), loaded.image.filename);
    let response: Response;
    try {
      response = await request((server.response as { upload_url: string }).upload_url, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        failure: { ok: false, reason: "temporary", error: `Не удалось загрузить картинку в ВК: ${withoutToken(reasonOf(error), bot.token)}` },
      };
    }
    const uploaded = (await response.json().catch(() => null)) as { server?: number; photo?: string; hash?: string } | null;
    if (!response.ok || !uploaded?.photo || uploaded.photo === "[]") {
      const reason = response.status >= 500 ? "temporary" : "permanent";
      return { ok: false, failure: { ok: false, reason, error: `ВК не принял картинку (ответ ${response.status})` } };
    }

    const saved = await call(bot.token, "photos.saveMessagesPhoto", {
      server: uploaded.server ?? 0,
      photo: uploaded.photo,
      hash: uploaded.hash ?? "",
    });
    if (!saved.ok) return { ok: false, failure: toFailure(saved) };
    const photo = (saved.response as Array<{ id: number; owner_id: number; access_key?: string }>)[0];
    if (!photo) return { ok: false, failure: { ok: false, reason: "permanent", error: "ВК не сохранил картинку" } };
    return { ok: true, attachment: `photo${photo.owner_id}_${photo.id}${photo.access_key ? `_${photo.access_key}` : ""}` };
  }
}

function toFailure(outcome: Extract<ApiOutcome, { ok: false }>): SendResult {
  if (outcome.code !== undefined && BLOCKED_CODES.has(outcome.code)) return { ok: false, reason: "blocked" };
  if (outcome.code === REPLY_WINDOW_CLOSED_CODE) return { ok: false, reason: "reply_window_closed" };
  if (outcome.code === ERROR_TOO_MANY_PER_SECOND) {
    return { ok: false, reason: "rate_limited", retryAfterMs: DEFAULT_RETRY_AFTER_MS };
  }
  // Ошибки 9 (однотипные сообщения) и 29 (исчерпан лимит метода, сбрасывается за часы) — не rate_limited: пауза
  // не засчитывается как попытка, и повтор мог бы не кончиться. Как temporary они считаются попытками, пауза растёт.
  const temporaryCode = TEMPORARY_CODES.has(outcome.code ?? 0);
  // 0 — сеть не ответила; 5xx — сбой ВК или нашего прокси: повторим позже
  if (temporaryCode || (outcome.code === undefined && (outcome.status === 0 || outcome.status >= 500))) {
    return { ok: false, reason: "temporary", error: outcome.description };
  }
  return { ok: false, reason: "permanent", error: outcome.description };
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
// Текст ошибки может содержать ключ (адрес запроса, ответ ВК): в журнал и интерфейс он не попадает
const withoutToken = (text: string, token: string) => text.replaceAll(token, "***");

/** Секрет сервера: ВК не любит «-» и «_», и длина ограничена. */
const vkSecret = (bot: BotCredentials) => alphanumericSecret(bot.webhookSecret).slice(0, SECRET_LIMIT);

/** `random_id` защищает ВК от дублей: для той же части того же сообщения он всегда одинаков. Целое от 1 до 2^31−1. */
function randomIdFor(idempotencyKey: string, partIndex: number): number {
  const digest = createHash("sha256").update(`${idempotencyKey}:${partIndex}`).digest();
  return (digest.readUInt32BE(0) % (2 ** 31 - 1)) + 1;
}

// --- разбор событий ---

interface VkResponse {
  response?: unknown;
  error?: { error_code: number; error_msg?: string };
}

interface VkGroup {
  id: number;
  name: string;
  screen_name?: string;
}

interface VkCallbackEvent {
  type: string;
  group_id?: number;
  secret?: string;
  event_id?: string;
  object?: {
    message?: VkMessage;
    user_id?: number;
    peer_id?: number;
    event_id?: string;
    /** Время события (секунды) — есть не у всех типов. */
    date?: number;
    payload?: unknown;
  };
}

interface VkMessage {
  id?: number;
  date?: number;
  out?: number;
  from_id: number;
  peer_id: number;
  text?: string;
  ref?: string;
  ref_source?: string;
  payload?: string;
  geo?: unknown;
  attachments?: Array<{ type: string }>;
}

function eventsFromCallback(event: VkCallbackEvent, botId: string): ChannelEvent[] {
  const object = event.object;
  const keyOf = (userId: number | string, tail: string | number | undefined) =>
    event.event_id ? `vk:${botId}:${event.event_id}` : `vk:${botId}:${event.type}:${userId}:${tail ?? ""}`;

  if (event.type === "message_new" && object?.message) {
    const message = object.message;
    // Только личные сообщения от человека: беседы (peer_id от 2 000 000 000), исходящие и сообщения от сообществ — нет
    if (message.out === 1 || message.from_id <= 0 || message.peer_id !== message.from_id) return [];
    const startCode = message.ref || message.ref_source || undefined;
    const attachment = attachmentOf(message);
    let text = message.text ?? "";
    // Кнопка «Начать» без ссылки с кодом — то же, что голый /start в Telegram
    if (!startCode && isStartButton(message.payload)) text = "/start";
    if (!text && !attachment) return [];
    return [
      {
        type: "message",
        dedupeKey: keyOf(message.from_id, message.id ?? message.date),
        userId: String(message.from_id),
        text,
        ...(attachment && { attachment }),
        ...(startCode && { startCode }),
      },
    ];
  }

  if (event.type === "message_event" && object?.user_id !== undefined && object.event_id) {
    const userId = String(object.user_id);
    return [
      {
        type: "button",
        dedupeKey: keyOf(userId, object.event_id),
        userId,
        // Для ответа на нажатие ВК нужны человек, диалог и событие: собираем в один идентификатор
        callbackId: `${userId}|${object.peer_id ?? userId}|${object.event_id}`,
        payload: buttonPayloadOf(object.payload),
      },
    ];
  }

  if ((event.type === "message_deny" || event.type === "message_allow") && object?.user_id !== undefined) {
    const userId = String(object.user_id);
    // Без event_id ключу нужно время: иначе второй запрет после разрешения совпал бы с первым и потерялся бы
    const happenedAt = object.date ?? Date.now();
    return [{ type: event.type === "message_deny" ? "blocked" : "unblocked", dedupeKey: keyOf(userId, happenedAt), userId }];
  }

  return [];
}

function isStartButton(payload: string | undefined): boolean {
  if (!payload) return false;
  try {
    return (JSON.parse(payload) as { command?: string }).command === "start";
  } catch {
    return false;
  }
}

/** ВК присылает данные кнопки объектом или строкой с JSON. */
function parsedPayload(payload: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof payload !== "string") return { ok: true, value: payload };
  try {
    return { ok: true, value: JSON.parse(payload) };
  } catch {
    return { ok: false };
  }
}

/** Наши кнопки кладут данные в `{"p": ...}`. */
function ourButtonData(value: unknown): string | undefined {
  const data = typeof value === "object" && value !== null ? (value as { p?: unknown }).p : undefined;
  return typeof data === "string" ? data : undefined;
}

/** Данные нашей кнопки; чужие остаются как есть. */
function buttonPayloadOf(payload: unknown): string {
  const parsed = parsedPayload(payload);
  if (!parsed.ok) return payload as string;
  return ourButtonData(parsed.value) ?? JSON.stringify(parsed.value);
}

function attachmentOf(message: VkMessage): AttachmentKind | undefined {
  // `link` — сниппет, который ВК сам добавляет к ссылке в тексте: это не вложение человека
  const type = message.attachments?.find((attachment) => attachment.type !== "link")?.type;
  if (type === "photo") return "image";
  if (type === "audio_message") return "voice";
  if (type === "sticker") return "sticker";
  if (type === "doc") return "file";
  return type || message.geo ? "other" : undefined;
}
