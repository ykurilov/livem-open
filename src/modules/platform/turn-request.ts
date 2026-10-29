/** Запросы, которые запускают ход агента. */
const TURN_ACTIONS = new Set(["messages", "retry", "edit", "regenerate"]);

/** Чат хода, если запрос запускает ход: `POST <basePath>/<chatId>/<action>`. */
export function turnChatId(request: Request, basePath: string): string | null {
  if (request.method.toUpperCase() !== "POST") return null;
  const path = new URL(request.url).pathname;
  if (!path.startsWith(`${basePath}/`)) return null;
  const [chatId, action, ...rest] = path.slice(basePath.length + 1).split("/");
  return chatId && action && rest.length === 0 && TURN_ACTIONS.has(action) ? decodeURIComponent(chatId) : null;
}
