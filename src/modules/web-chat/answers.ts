import type { WebChatOpened, WebChatSendResult } from "./web-chat";

/** Что ответить браузеру: код и тело. Одно и то же у страницы чата и у виджета на сайте — отличается только вход. */
export interface WebChatAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** Ответ на вход посетителя (без токена: страница кладёт его в cookie, виджет — в тело). */
export function webChatOpenedAnswer(opened: WebChatOpened): WebChatAnswer {
  switch (opened.kind) {
    case "limited":
      return { status: 429, body: { error: opened.error } };
    case "not_found":
      return { status: 404, body: { error: "Чат не найден: ссылка устарела или лидмагнит снят с публикации" } };
    case "retry":
      return { status: 503, body: { error: opened.error } };
    case "closed":
      return { status: 409, body: { error: "Этот чат закончен", current: opened.current } };
    case "opened":
      return { status: 200, body: { title: opened.title } };
  }
}

/** Ответ на сообщение посетителя. */
export function webChatSendAnswer(result: WebChatSendResult): WebChatAnswer {
  if (result.ok) return { status: 200, body: { ok: true, item: result.item } };
  const status =
    result.reason === "too_fast" || result.reason === "too_many"
      ? 429
      : result.reason === "retry"
        ? 503
        : result.reason === "other_chat" || result.reason === "messenger"
          ? 409
          : 400;
  return { status, body: { error: result.error, ...(result.reason === "other_chat" && { current: result.current }) } };
}
