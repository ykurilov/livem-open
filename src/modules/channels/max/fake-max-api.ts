// Подделка сервера Max Bot API для тестов: подставляется вместо `fetch`, в сеть ничего не уходит.

export interface MaxRequest {
  /** Например, «POST /messages». */
  route: string;
  query: Record<string, string>;
  /** Заголовок `Authorization`: у Max в нём лежит токен как есть. */
  authorization: string | null;
  /** JSON-объект, `FormData` (загрузка файла) или `undefined`, если тела нет. */
  body: Record<string, unknown> | FormData | undefined;
}

export interface MaxReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown): MaxReply => ({ status: 200, body });

export const maxError = (status: number, code: string, message = code, headers?: Record<string, string>): MaxReply => ({
  status,
  body: { code, message },
  ...(headers && { headers }),
});

export const UPLOAD_URL = "https://upload.max.test/upload?id=77&sig=abc";

const BOT = {
  user_id: 123456,
  first_name: "Живой лидмагнит",
  name: "Живой лидмагнит",
  username: "live_magnet_bot",
  is_bot: true,
  last_activity_time: 1790000000000,
};

const DEFAULT_REPLIES: Record<string, () => MaxReply> = {
  "GET /me": () => ok(BOT),
  "GET /subscriptions": () => ok({ subscriptions: [] }),
  "POST /subscriptions": () => ok({ success: true }),
  "DELETE /subscriptions": () => ok({ success: true }),
  "POST /messages": () =>
    ok({ message: { sender: { user_id: 123456, is_bot: true }, recipient: { user_id: 5550001 }, timestamp: 1790000000000, body: { mid: "mid.0000000000a1b2c3", seq: 1 } } }),
  "POST /uploads": () => ok({ url: UPLOAD_URL }),
  "POST /answers": () => ok({ success: true }),
};

export class FakeMaxApi {
  readonly requests: MaxRequest[] = [];
  readonly uploads: Array<{ url: string; form: FormData }> = [];
  private readonly scripted = new Map<string, Array<MaxReply | Error>>();
  private uploadReply: MaxReply | Error | null = null;

  /** Следующий вызов получит этот ответ (или упадёт этой ошибкой сети). Ключ — «POST /messages». */
  replyOnce(route: string, reply: MaxReply | Error): void {
    this.scripted.set(route, [...(this.scripted.get(route) ?? []), reply]);
  }

  /** Ответ сервера загрузки файла (по умолчанию — настоящий вид: токен картинки в `photos`). */
  replyToUploadOnce(reply: MaxReply | Error): void {
    this.uploadReply = reply;
  }

  callsTo(route: string): MaxRequest[] {
    return this.requests.filter((request) => request.route === route);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const httpMethod = (init?.method ?? "GET").toUpperCase();

    if (url.origin === new URL(UPLOAD_URL).origin) {
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error("На сервер загрузки ушла не форма");
      this.uploads.push({ url: url.toString(), form });
      const reply = this.uploadReply ?? ok({ photos: { "photo-id-1": { token: "IMG-TOKEN-1" } } });
      this.uploadReply = null;
      if (reply instanceof Error) throw reply;
      return toResponse(reply);
    }

    const route = `${httpMethod} ${url.pathname}`;
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    this.requests.push({
      route,
      query: Object.fromEntries(url.searchParams),
      authorization: headers.get("authorization"),
      body: typeof rawBody === "string" ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined,
    });

    const scripted = this.scripted.get(route)?.shift();
    if (scripted instanceof Error) throw scripted;
    const reply = scripted ?? DEFAULT_REPLIES[route]?.();
    if (!reply) throw new Error(`Подделка Max не знает запрос ${route}`);
    return toResponse(reply);
  };
}

function toResponse(reply: MaxReply): Response {
  const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
  return new Response(text, { status: reply.status, headers: { "content-type": "application/json", ...reply.headers } });
}
