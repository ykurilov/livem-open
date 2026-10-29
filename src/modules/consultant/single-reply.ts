import type { ChatStorage, StoredMessage } from "@ykurilov/agent-chat-core";

/**
 * Один ответ человеку за ход. Модель иногда пишет текст, вызывает инструмент и пишет ещё раз — почти тот же вопрос.
 * Человек получает последний непустой кусок текста между вызовами инструментов, вызовы остаются на месте.
 * Чистая функция: её зовут и хранилище ответов, и экран предпросмотра.
 */
export function keepLastReply<T>(parts: readonly T[], kind: { textOf(part: T): string | null; isToolCall(part: T): boolean }): T[] {
  const lastSaid = parts.findLastIndex((part) => (kind.textOf(part) ?? "").trim().length > 0);
  if (lastSaid === -1) return [...parts];
  const replyStart = parts.slice(0, lastSaid).findLastIndex((part) => kind.isToolCall(part)) + 1;
  return parts.filter((part, index) => index >= replyStart || kind.textOf(part) === null);
}

type StoredPart = StoredMessage["parts"][number];

const storedPartKind = {
  textOf: (part: StoredPart) => (part.type === "text" ? part.text : null),
  isToolCall: (part: StoredPart) => part.type.startsWith("tool-") || part.type === "dynamic-tool",
};

export function lastReplyParts(parts: StoredMessage["parts"]): StoredMessage["parts"] {
  return keepLastReply(parts, storedPartKind);
}

/**
 * Хранилище, в котором законченный ответ консультанта сохраняется уже одним ответом: история, которую модель увидит
 * на следующем ходе, совпадает с тем, что получил человек. Остальное — как у исходного хранилища.
 */
export function singleReplyStorage(storage: ChatStorage): ChatStorage {
  return new Proxy(storage, {
    get(target, property) {
      if (property === "finishMessage")
        return ((messageId, final) =>
          target.finishMessage(
            messageId,
            final.status === "complete" && final.parts ? { ...final, parts: lastReplyParts(final.parts) } : final,
          )) satisfies ChatStorage["finishMessage"];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
