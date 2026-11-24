import type { WebChatElsewhere, WebChatHandoffState, WebChatItem } from "@/modules/web-chat/web-chat";
import { readStorage, removeStorage, writeStorage } from "./browser-storage";

/** Дольше ответа не ждём: повисший запрос (сеть «полуоткрыта») считается сбоем, человеку — ошибка с повтором. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Ключ хранилища сайта, где виджет помнит посетителя: сторонние cookie браузеры режут. */
export const WIDGET_VISITOR_KEY = "livem-chat-visitor";

export type CurrentChat = WebChatElsewhere["current"];

/** Вход посетителя. `pushKey` — только у страницы, `voiceTicket` — только у API: голос без cookie. */
export type WebChatEntry =
  | { ok: true; pushKey: string | null; voiceTicket: string | null }
  | { ok: false; error: string; retryable: boolean; current?: CurrentChat };

/** `lost` — вход потерян (стёрли cookie или токен): опрос сам не починится. */
export type WebChatFeed = { kind: "feed"; items: WebChatItem[]; handoff: WebChatHandoffState | null } | { kind: "lost" } | { kind: "failed" };

export type WebChatSent = { ok: true; item: WebChatItem | null } | { ok: false; status: number | null; error: string | null; current?: CurrentChat };

/** `clientId` — один на сообщение: повтор после обрыва сети уходит с тем же, и сервер второго не создаёт. */
export interface OutgoingMessage {
  text: string;
  clientId: string;
  photo?: Blob;
}

/** Как общий вид веб-чата достаёт до сервера: страница `/c/<код>` или публичный API на чужом сайте. */
export interface WebChatTransport {
  /**
   * Вход — один на загрузку: два одновременных первых входа завели бы двух посетителей (React в разработке запускает
   * эффект дважды). Сбой забывается сам, повтор пойдёт заново.
   */
  enter(): Promise<WebChatEntry>;
  /** Следующий вход — заново: повтор после сбоя или возврат в этот чат из другого. */
  forgetEntry(): void;
  /** Лента; `since` — только новее. */
  feed(since: string | null): Promise<WebChatFeed>;
  send(message: OutgoingMessage): Promise<WebChatSent>;
}

const ENTRY_FAILED = "Не получилось открыть чат. Проверьте интернет и попробуйте снова.";

/** Вход посетителя с запоминанием: тот же ответ до сбоя или `forgetEntry`. */
function rememberedEntry(request: () => Promise<WebChatEntry>): Pick<WebChatTransport, "enter" | "forgetEntry"> {
  let entry: Promise<WebChatEntry> | null = null;
  return {
    enter() {
      entry ??= request().then((result) => {
        if (!result.ok) entry = null;
        return result;
      });
      return entry;
    },
    forgetEntry() {
      entry = null;
    },
  };
}

async function postMessage(url: string, message: OutgoingMessage, extra: Record<string, string>, headers: Record<string, string>): Promise<WebChatSent> {
  let body: BodyInit;
  const sendHeaders = { ...headers };
  if (message.photo) {
    const form = new FormData();
    form.set("text", message.text);
    form.set("clientId", message.clientId);
    for (const [name, value] of Object.entries(extra)) form.set(name, value);
    form.set("photo", message.photo);
    body = form;
  } else {
    body = JSON.stringify({ text: message.text, clientId: message.clientId, ...extra });
    sendHeaders["content-type"] = "application/json";
  }
  const response = await fetch(url, { method: "POST", headers: sendHeaders, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
  const answer = (await response?.json().catch(() => null)) as { item?: WebChatItem | null; error?: string; current?: CurrentChat } | null;
  if (response?.ok) return { ok: true, item: answer?.item ?? null };
  return { ok: false, status: response?.status ?? null, error: answer?.error ?? null, ...(answer?.current && { current: answer.current }) };
}

function timeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Страница `/c/<код>` на адресе приложения: посетитель — по cookie. `resume` — код входа веб-приложения с экрана «Домой». */
export function pageTransport(code: string, takeResume: () => string | null, onResumed: () => void): WebChatTransport {
  return {
    ...rememberedEntry(async () => {
      const resume = takeResume();
      const response = await fetch("/api/web-chat/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, resume, timeZone: timeZone() }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => null);
      const body = (await response?.json().catch(() => null)) as { pushKey?: string | null; error?: string; current?: CurrentChat } | null;
      // Ссылка устарела — повтор не поможет
      if (!response?.ok) return { ok: false, error: body?.error ?? ENTRY_FAILED, retryable: response?.status !== 404, ...(body?.current && { current: body.current }) };
      if (resume) onResumed();
      return { ok: true, pushKey: body?.pushKey ?? null, voiceTicket: null };
    }),
    async feed(since) {
      const query = new URLSearchParams({ code, ...(since && { since }) });
      const response = await fetch(`/api/web-chat/messages?${query}`, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
      if (response?.status === 401) return { kind: "lost" };
      const body = response?.ok ? ((await response.json().catch(() => null)) as { items?: WebChatItem[]; handoff?: WebChatHandoffState | null } | null) : null;
      return body?.items ? { kind: "feed", items: body.items, handoff: body.handoff ?? null } : { kind: "failed" };
    },
    send: (message) => postMessage("/api/web-chat/messages", message, { code }, {}),
  };
}

/** О чате до входа: название, принимает ли фото, есть ли микрофон. `refused` — сайт не из списка или ссылка устарела. */
export type ChatAbout = { ok: true; title: string; photos: boolean; voice: boolean } | { ok: false; refused: boolean; error: string };

export interface ChatApiTransport extends WebChatTransport {
  about(): Promise<ChatAbout>;
}

/**
 * Публичный API v1 на чужом сайте: посетитель — по токену из хранилища сайта, заголовком `Authorization`.
 * `onRefused` — сайт не из списка разрешённых или чат не найден: причина для консоли сайта.
 */
export function chatApiTransport({ origin, code, onRefused }: { origin: string; code: string; onRefused?: (error: string) => void }): ChatApiTransport {
  const base = `${origin}/api/v1/chats/${encodeURIComponent(code)}`;
  const authorization = (): Record<string, string> => {
    const token = readStorage(WIDGET_VISITOR_KEY);
    return token ? { authorization: `Bearer ${token}` } : {};
  };
  const refused = (status: number | undefined, error: string | undefined) => {
    if ((status === 403 || status === 404) && error) onRefused?.(error);
  };

  return {
    async about() {
      const response = await fetch(base, { headers: authorization(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
      const body = (await response?.json().catch(() => null)) as { title?: string; photos?: boolean; voice?: boolean; error?: string } | null;
      if (response?.ok && body?.title) return { ok: true, title: body.title, photos: body.photos === true, voice: body.voice === true };
      refused(response?.status, body?.error);
      return { ok: false, refused: response?.status === 403 || response?.status === 404, error: body?.error ?? ENTRY_FAILED };
    },
    ...rememberedEntry(async () => {
      const response = await fetch(`${base}/session`, {
        method: "POST",
        headers: { ...authorization(), "content-type": "application/json" },
        body: JSON.stringify({ timeZone: timeZone() }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => null);
      const body = (await response?.json().catch(() => null)) as { token?: string; voiceTicket?: string | null; error?: string; current?: CurrentChat } | null;
      // Токен приходит и при сбое начала: повтор будет тем же посетителем
      if (body?.token) writeStorage(WIDGET_VISITOR_KEY, body.token);
      if (!response?.ok) {
        refused(response?.status, body?.error);
        const retryable = response?.status !== 404 && response?.status !== 403;
        return { ok: false, error: body?.error ?? ENTRY_FAILED, retryable, ...(body?.current && { current: body.current }) };
      }
      return { ok: true, pushKey: null, voiceTicket: body?.voiceTicket ?? null };
    }),
    async feed(since) {
      const query = since ? `?${new URLSearchParams({ since })}` : "";
      const response = await fetch(`${base}/messages${query}`, { headers: authorization(), cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
      if (response?.status === 401) {
        removeStorage(WIDGET_VISITOR_KEY);
        return { kind: "lost" };
      }
      const body = response?.ok ? ((await response.json().catch(() => null)) as { messages?: WebChatItem[]; handoff?: WebChatHandoffState | null } | null) : null;
      return body?.messages ? { kind: "feed", items: body.messages, handoff: body.handoff ?? null } : { kind: "failed" };
    },
    send: (message) => postMessage(`${base}/messages`, message, {}, authorization()),
  };
}
