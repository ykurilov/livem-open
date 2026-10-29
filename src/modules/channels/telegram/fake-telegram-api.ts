// Подделка сервера Telegram Bot API для тестов: подставляется вместо `fetch`, в сеть ничего не уходит.

export interface TelegramRequest {
  method: string;
  token: string;
  /** Тело запроса: JSON-объект или `FormData` (загрузка файла). */
  body: Record<string, unknown> | FormData;
}

export interface TelegramReply {
  status: number;
  body: unknown;
}

const ok = (result: unknown): TelegramReply => ({ status: 200, body: { ok: true, result } });

const BOT_IDENTITY = { id: 123456789, is_bot: true, first_name: "Живой лидмагнит", username: "live_magnet_bot" };

const DEFAULT_REPLIES: Record<string, () => TelegramReply> = {
  getMe: () => ok(BOT_IDENTITY),
  setWebhook: () => ok(true),
  deleteWebhook: () => ok(true),
  getWebhookInfo: () => ok({ url: "", has_custom_certificate: false, pending_update_count: 0 }),
  getUpdates: () => ok([]),
  answerCallbackQuery: () => ok(true),
  sendMessage: () => ok({ message_id: 77, chat: { id: 5550001, type: "private" }, date: 1790000000, text: "…" }),
  sendPhoto: () => ok({ message_id: 78, chat: { id: 5550001, type: "private" }, date: 1790000000, photo: [] }),
};

export const telegramError = (status: number, description: string, parameters?: { retry_after: number }): TelegramReply => ({
  status,
  body: { ok: false, error_code: status, description, ...(parameters && { parameters }) },
});

/** Ответ `getWebhookInfo`: бот подключён к сервису по этому адресу (пустой — вебхука нет). */
export const webhookInfo = (url: string): TelegramReply => ok({ url, has_custom_certificate: false, pending_update_count: 0 });

/** Ответ Telegram, когда бота уже читает другая программа через `getUpdates`. */
export const getUpdatesConflict = (): TelegramReply =>
  telegramError(409, "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running");

export class FakeTelegramApi {
  readonly requests: TelegramRequest[] = [];
  private readonly scripted = new Map<string, Array<TelegramReply | Error>>();

  /** Следующий вызов метода получит этот ответ (или упадёт этой ошибкой сети). Ответы выдаются по очереди. */
  replyOnce(method: string, reply: TelegramReply | Error): void {
    this.scripted.set(method, [...(this.scripted.get(method) ?? []), reply]);
  }

  callsTo(method: string): TelegramRequest[] {
    return this.requests.filter((request) => request.method === method);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const match = /\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
    if (!match?.[1] || !match[2]) throw new Error(`Подделка Telegram не знает адрес ${url.pathname}`);
    const [, token, method] = match;

    const rawBody = init?.body;
    const body =
      rawBody instanceof FormData
        ? rawBody
        : typeof rawBody === "string"
          ? (JSON.parse(rawBody) as Record<string, unknown>)
          : {};
    this.requests.push({ method, token, body });

    const scripted = this.scripted.get(method)?.shift();
    if (scripted instanceof Error) throw scripted;
    const reply = scripted ?? DEFAULT_REPLIES[method]?.();
    if (!reply) throw new Error(`Подделка Telegram не знает метод ${method}`);
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status, headers: { "content-type": "application/json" } });
  };
}
