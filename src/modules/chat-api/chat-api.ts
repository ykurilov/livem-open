import { webChatCodeOfVoiceChat } from "../voice/access";
import { clientAddress } from "../web-chat/address";
import {
  findWebChatVisitor,
  newVisitorsPerAddress,
  openWebChat,
  pagesPerAddress,
  readSentMessage,
  readWebChat,
  sendWebChatMessage,
  takeWebChatLimit,
  webChatImagePath,
  webChatImageResponse,
  webChatLeadMagnetId,
  webChatMessengerHandoff,
  webChatOpenedAnswer,
  webChatPhotosAccepted,
  webChatSendAnswer,
  webChatTitle,
  webChatVoiceInput,
  type WebChatDependencies,
  type WebChatItem,
} from "../web-chat";
import { browserSiteRefusal, type BrowserSite } from "./allowed-sites-store";
import { CHAT_API_KEY_PREFIX, chatApiKeyLeadMagnet } from "./keys";
import { SERVER_VISITOR_ID_MAX_LENGTH, serverVisitorToken } from "./server-visitors";
import type { ChatSignatures } from "./signatures";

/** Заголовок, которым сервер эксперта называет своего посетителя. */
export const CHAT_API_VISITOR_HEADER = "Livem-Visitor";

export interface ChatApiDependencies extends WebChatDependencies {
  /** Адрес приложения (`PUBLIC_BASE_URL`): его страницы — свой сайт, от него ссылки на картинки. */
  appOrigin: string;
  signatures: ChatSignatures;
  /** На сервере есть ключ распознавания речи: без него микрофона нет. */
  voiceConfigured: boolean;
}

/**
 * Публичный API чата лидмагнита (`/api/v1/chats/{code}/…`) — тот же веб-чат, другой вход. Из браузера посетитель — по
 * токену в `Authorization` (сторонние cookie браузеры режут), сайт сверяется со списком разрешённых до любых действий.
 * С сервера эксперта — ключ лидмагнита и свой id посетителя (`Livem-Visitor`). Виджет — первый клиент этого API.
 */
export interface ChatApi {
  /** Предварительный запрос браузера перед запросом с токеном. */
  preflight(request: Request): Response;
  /** `GET` — название, принимает ли фото, есть ли микрофон. Ничего не начинает. */
  chat(request: Request, code: string): Promise<Response>;
  /** `POST {timeZone?}` — начать или продолжить разговор. Браузеру — токен посетителя и билет голоса. */
  session(request: Request, code: string): Promise<Response>;
  /** `GET ?since` — история и новые сообщения, кнопки мессенджеров. */
  messages(request: Request, code: string): Promise<Response>;
  /** `POST {text, clientId?}` или форма `text`, `clientId`, `photo` — сообщение посетителя. */
  send(request: Request, code: string): Promise<Response>;
  /** Картинка по подписанной ссылке из истории. */
  image(request: Request, messageId: string): Promise<Response>;
}

/** Кто пришёл: браузер с сайта или сервер эксперта за своего посетителя. `token` — посетитель веб-чата, если уже есть. */
interface Caller {
  browser: boolean;
  token: string | null;
  /** Счёт ограничений частоты: адрес человека, у сервера — его ключ. */
  address: string;
}

type Entry = { ok: true; caller: Caller } | { ok: false; response: Response };

const CODE_MAX_LENGTH = 200;
const NOT_FOUND = "Чат не найден: ссылка устарела или лидмагнит снят с публикации";
const NO_VISITOR = "Посетитель не начал разговор: сначала вход (POST session)";

export function createChatApi(deps: ChatApiDependencies): ChatApi {
  /** Кто пришёл и можно ли ему в этот чат. `createVisitor` — сервер эксперта входит впервые за этого посетителя. */
  async function enter(request: Request, code: string, options: { createVisitor?: boolean } = {}): Promise<Entry> {
    const fail = (status: number, error: string, cors = true): Entry => ({ ok: false, response: reply(request, { error }, status, cors) });
    const leadMagnetId = code && code.length <= CODE_MAX_LENGTH ? await webChatLeadMagnetId(deps.db, code) : null;
    if (!leadMagnetId) return fail(404, NOT_FOUND);
    const bearer = bearerToken(request);

    if (!bearer?.startsWith(CHAT_API_KEY_PREFIX)) {
      const refusal = await browserSiteRefusal(deps.db, leadMagnetId, browserSite(request, deps.appOrigin));
      if (refusal) return fail(403, refusal);
      return { ok: true, caller: { browser: true, token: bearer, address: clientAddress(request.headers) } };
    }

    // Ключ виден любому, кто открыл страницу: из браузера (запрос с Origin) он не принимается, ответ сайту не открыт
    if (request.headers.get("origin"))
      return fail(403, "Секретный ключ нельзя отправлять из браузера: его увидит любой посетитель сайта. Ключ — только для сервера.", false);
    const keyLeadMagnetId = await chatApiKeyLeadMagnet(deps.db, bearer);
    if (!keyLeadMagnetId) return fail(401, "Ключ не подошёл: он отозван или набран с ошибкой");
    if (keyLeadMagnetId !== leadMagnetId) return fail(403, "Этот ключ от другого лидмагнита");
    const externalId = request.headers.get(CHAT_API_VISITOR_HEADER)?.trim() ?? "";
    if (!externalId || externalId.length > SERVER_VISITOR_ID_MAX_LENGTH)
      return fail(400, `Укажите id посетителя в заголовке ${CHAT_API_VISITOR_HEADER}: до ${SERVER_VISITOR_ID_MAX_LENGTH} знаков`);

    const address = `key:${leadMagnetId}`;
    const visitorInput = { leadMagnetId, externalId, code };
    let token = await serverVisitorToken(deps, visitorInput, { create: false });
    if (!token && options.createVisitor) {
      if (!(await takeWebChatLimit(deps.db, deps.clock.now(), newVisitorsPerAddress(address))))
        return fail(429, "Слишком много новых посетителей за час. Попробуйте позже.");
      token = await serverVisitorToken(deps, visitorInput, { create: true });
    }
    return { ok: true, caller: { browser: false, token, address } };
  }

  const voiceOn = async (code: string) => deps.voiceConfigured && (await webChatVoiceInput(deps.db, code));

  /** Картинка в `<img>` на чужом сайте заголовок с токеном не пошлёт: ссылка подписана и ведёт на адрес приложения. */
  const withSignedImage = (item: WebChatItem, visitorId: string): WebChatItem =>
    item.imageUrl ? { ...item, imageUrl: deps.signatures.imageUrl(deps.appOrigin, visitorId, item.id) } : item;

  return {
    preflight(request) {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request),
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type",
          "access-control-max-age": "600",
        },
      });
    },

    async chat(request, code) {
      const entry = await enter(request, code);
      if (!entry.ok) return entry.response;
      const { caller } = entry;
      if (!(await takeWebChatLimit(deps.db, deps.clock.now(), pagesPerAddress(caller.address))))
        return reply(request, { error: "Слишком много запросов. Подождите минуту." }, 429);
      const title = await webChatTitle(deps.db, code, await findWebChatVisitor(deps.db, caller.token));
      if (!title) return reply(request, { error: NOT_FOUND }, 404);
      return reply(request, { title, photos: await webChatPhotosAccepted(deps.db, code), voice: caller.browser && (await voiceOn(code)) });
    },

    async session(request, code) {
      const entry = await enter(request, code, { createVisitor: true });
      if (!entry.ok) return entry.response;
      const { caller } = entry;
      const body = (await request.json().catch(() => null)) as { timeZone?: unknown } | null;
      const timeZone = typeof body?.timeZone === "string" ? body.timeZone.slice(0, 100) : null;
      const opened = await openWebChat(deps, { token: caller.token, code, address: caller.address, timeZone });
      const answer = webChatOpenedAnswer(opened);
      if (!caller.browser) return reply(request, answer.body, answer.status);
      // Браузер хранит токен сам — и после сбоя начала: повтор будет тем же посетителем
      const token = "token" in opened ? opened.token : undefined;
      const voiceTicket = opened.kind === "opened" && (await voiceOn(code)) ? deps.signatures.voiceTicket(opened.visitorId) : null;
      return reply(request, { ...answer.body, ...(token && { token }), ...(opened.kind === "opened" && { voiceTicket }) }, answer.status);
    },

    async messages(request, code) {
      const entry = await enter(request, code);
      if (!entry.ok) return entry.response;
      const visitor = await findWebChatVisitor(deps.db, entry.caller.token);
      if (!visitor) return reply(request, { error: NO_VISITOR }, 401);
      const sinceParam = new URL(request.url).searchParams.get("since");
      const since = sinceParam ? new Date(sinceParam) : null;
      const items = await readWebChat(deps.db, deps.clock, visitor, { since: since && !Number.isNaN(since.getTime()) ? since : undefined });
      const handoff = await webChatMessengerHandoff(deps.db, deps.adapters, visitor, code);
      return reply(request, { messages: items.map((item) => withSignedImage(item, visitor.id)), handoff });
    },

    async send(request, code) {
      const entry = await enter(request, code);
      if (!entry.ok) return entry.response;
      const visitor = await findWebChatVisitor(deps.db, entry.caller.token);
      if (!visitor) return reply(request, { error: NO_VISITOR }, 401);
      const message = await readSentMessage(request);
      if (!message.ok) return reply(request, { error: message.error }, message.status);
      const { text, clientId, photo } = message;
      const result = await sendWebChatMessage(deps, visitor, { text, clientId, photo, code, address: entry.caller.address });
      const answer = webChatSendAnswer(result);
      const item = result.ok && result.item ? withSignedImage(result.item, visitor.id) : undefined;
      return reply(request, item ? { ...answer.body, item } : answer.body, answer.status);
    },

    async image(request, messageId) {
      const visitorId = deps.signatures.visitorOfImage(messageId, new URL(request.url).searchParams);
      const path = visitorId ? await webChatImagePath(deps.db, { id: visitorId }, messageId) : null;
      if (!path) return new Response("Not found", { status: 404 });
      return webChatImageResponse(path, deps.uploadsDir);
    },
  };
}

/**
 * Посетитель для голоса из браузера: WebSocket заголовков не шлёт, поэтому билет из входа (`?ticket=`) и сверка сайта
 * соединения со списком лидмагнита из `?chat=`. Нет билета, подделка или чужой сайт — `null`.
 */
export async function chatVoiceVisitorId(deps: Pick<ChatApiDependencies, "db" | "signatures" | "appOrigin">, request: Request): Promise<string | null> {
  const params = new URL(request.url).searchParams;
  const visitorId = deps.signatures.visitorOfVoiceTicket(params.get("ticket"));
  const code = webChatCodeOfVoiceChat(params.get("chat"));
  if (!visitorId || !code) return null;
  const leadMagnetId = await webChatLeadMagnetId(deps.db, code);
  if (!leadMagnetId) return null;
  return (await browserSiteRefusal(deps.db, leadMagnetId, browserSite(request, deps.appOrigin))) ? null : visitorId;
}

function browserSite(request: Request, appOrigin: string): BrowserSite {
  const origin = request.headers.get("origin");
  // Запрос со страницы самого приложения браузер может прислать без Origin (GET того же адреса)
  const own = origin ? sameOrigin(origin, appOrigin) : request.headers.get("sec-fetch-site") === "same-origin";
  return { origin, own };
}

function sameOrigin(origin: string, appOrigin: string): boolean {
  try {
    return new URL(origin).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return { vary: "Origin", ...(origin && { "access-control-allow-origin": origin }) };
}

function reply(request: Request, body: unknown, status = 200, cors = true): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...(cors ? corsHeaders(request) : { vary: "Origin" }) } });
}
