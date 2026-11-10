import type { StoredMessage } from "@ykurilov/agent-chat-core";

/** Инструмент SDK, которым консультант прикладывает к ответу готовые ответы человека (базовый виджет). */
export const QUICK_REPLIES_TOOL = "suggest_replies";
/** Больше SDK не даёт: столько кнопок удобно нажимать на телефоне. */
const QUICK_REPLIES_LIMIT = 4;

/** Готовые ответы человека к ответу консультанта: последний вызов `suggest_replies`, без пустых и повторов. Нет — пусто. */
export function quickRepliesOf(parts: StoredMessage["parts"]): string[] {
  const call = parts.findLast((part) => part.type === `tool-${QUICK_REPLIES_TOOL}`) as { input?: { replies?: unknown } } | undefined;
  const replies = call?.input?.replies;
  if (!Array.isArray(replies)) return [];
  const clean = replies.flatMap((reply) => (typeof reply === "string" && reply.trim() ? [reply.trim()] : []));
  return [...new Set(clean)].slice(0, QUICK_REPLIES_LIMIT);
}
