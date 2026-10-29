// Подделка сервера ВК для тестов: подставляется вместо `fetch`, в сеть ничего не уходит.
// Методы API принимают форму (application/x-www-form-urlencoded); загрузка фото — multipart на отдельный адрес.

export interface VkRequest {
  method: string;
  /** Все поля формы, включая `access_token` и `v`. */
  params: Record<string, string>;
}

export interface VkUpload {
  url: string;
  form: FormData;
}

export interface VkReply {
  status: number;
  body: unknown;
}

const ok = (response: unknown): VkReply => ({ status: 200, body: { response } });

export const vkError = (code: number, message: string): VkReply => ({
  status: 200,
  body: { error: { error_code: code, error_msg: message, request_params: [] } },
});

export const UPLOAD_URL = "https://upload.vk.test/photo?hash=abc";

const GROUP = { id: 222333, name: "Живые лидмагниты", screen_name: "live_magnet_club", is_closed: 0, type: "group" };

const DEFAULT_REPLIES: Record<string, () => VkReply> = {
  "groups.getById": () => ok({ groups: [GROUP] }),
  // Ключ с правами «Управление сообществом», «Сообщения сообщества», «Фотографии»
  "groups.getTokenPermissions": () => ok({ mask: 262144 + 4096 + 4, permissions: [] }),
  "groups.getCallbackConfirmationCode": () => ok({ code: "a1b2c3d4" }),
  "groups.setCallbackSettings": () => ok(1),
  "messages.send": () => ok(4001),
  "messages.sendMessageEventAnswer": () => ok(1),
  "photos.getMessagesUploadServer": () => ok({ upload_url: UPLOAD_URL, album_id: -64, group_id: 222333 }),
  "photos.saveMessagesPhoto": () => ok([{ id: 456239017, owner_id: -222333, album_id: -64 }]),
};

export interface VkCallbackServer {
  id: number;
  url: string;
  title: string;
}

export class FakeVkApi {
  readonly requests: VkRequest[] = [];
  /** Callback-серверы сообщества: добавление и удаление меняют список, как у настоящего ВК. Первый добавленный — 77. */
  callbackServers: VkCallbackServer[] = [];
  private nextServerId = 77;
  readonly uploads: VkUpload[] = [];
  private readonly scripted = new Map<string, Array<VkReply | Error>>();
  private readonly files = new Map<string, { status: number; bytes: Uint8Array }>();
  private uploadReply: VkReply | Error | null = null;

  /** Следующий вызов метода получит этот ответ (или упадёт этой ошибкой сети). Ответы выдаются по очереди. */
  replyOnce(method: string, reply: VkReply | Error): void {
    this.scripted.set(method, [...(this.scripted.get(method) ?? []), reply]);
  }

  /** Ответ сервера загрузки фото (по умолчанию — настоящий вид ответа: server, photo, hash). */
  replyToUploadOnce(reply: VkReply | Error): void {
    this.uploadReply = reply;
  }

  /** Картинка, которую можно скачать по ссылке. */
  serveFile(url: string, bytes: Uint8Array, status = 200): void {
    this.files.set(url, { status, bytes });
  }

  callsTo(method: string): VkRequest[] {
    return this.requests.filter((request) => request.method === method);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());

    const file = this.files.get(url.toString());
    if (file) return new Response(Buffer.from(file.bytes), { status: file.status, headers: { "content-type": "image/png" } });

    if (url.origin === new URL(UPLOAD_URL).origin) {
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error("На сервер загрузки фото ушла не форма");
      this.uploads.push({ url: url.toString(), form });
      const reply = this.uploadReply ?? { status: 200, body: { server: 999001, photo: '[{"markers_restarted":true}]', hash: "h4sh" } };
      this.uploadReply = null;
      if (reply instanceof Error) throw reply;
      return jsonResponse(reply);
    }

    const method = /\/method\/([A-Za-z.]+)$/.exec(url.pathname)?.[1];
    if (!method) throw new Error(`Подделка ВК не знает адрес ${url.toString()}`);
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    this.requests.push({ method, params });

    const scripted = this.scripted.get(method)?.shift();
    if (scripted instanceof Error) throw scripted;
    const reply = scripted ?? this.callbackServerReply(method, params) ?? DEFAULT_REPLIES[method]?.();
    if (!reply) throw new Error(`Подделка ВК не знает метод ${method}`);
    return jsonResponse(reply);
  };

  private callbackServerReply(method: string, params: Record<string, string>): VkReply | undefined {
    if (method === "groups.getCallbackServers") {
      return ok({ count: this.callbackServers.length, items: this.callbackServers.map((server) => ({ ...server, status: "ok" })) });
    }
    if (method === "groups.addCallbackServer") {
      // Как настоящий ВК: название сервера — не длиннее 14 букв (живое подключение 19.10 упало на «Живые лидмагниты»)
      if ([...(params.title ?? "")].length > 14) return vkError(100, "One of the parameters specified was missing or invalid: title should be not more 14 letters length");
      const id = this.nextServerId++;
      this.callbackServers.push({ id, url: params.url ?? "", title: params.title ?? "" });
      return ok({ server_id: id });
    }
    if (method === "groups.deleteCallbackServer") {
      this.callbackServers = this.callbackServers.filter((server) => String(server.id) !== params.server_id);
      return ok(1);
    }
    return undefined;
  }
}

function jsonResponse(reply: VkReply): Response {
  const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
  return new Response(text, { status: reply.status, headers: { "content-type": "application/json" } });
}
