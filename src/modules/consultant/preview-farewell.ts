import type { ChatStorage, StoredMessage } from "@ykurilov/agent-chat-core";
import { appClosingAfter, appClosingText, type DialogSummary } from "./schema";
import { lastReplyParts } from "./single-reply";

/** Последнее сообщение приложения вместо текста модели, как в мессенджере: вызовы инструментов остаются, текст — один. */
export function replaceReplyText(parts: StoredMessage["parts"], text: string): StoredMessage["parts"] {
  return [...lastReplyParts(parts).filter((part) => part.type !== "text"), { type: "text", text }];
}

/**
 * Хранилище тестового разговора: ответ, на котором человек согласился с итогом, сохраняется вместе с прощанием приложения.
 * Эксперт видит прощание в ленте там же, где его увидит человек, а не отдельной плашкой.
 */
export function previewFarewellStorage(
  storage: ChatStorage,
  input: {
    farewellMessage: string;
    summaryOf(chatId: string): Promise<DialogSummary | null>;
    /** Ответ из `finish_dialog` — не текст модели, служба SDK его не проверяет: проверка (чужие слова, ссылки) — здесь. */
    checkedAnswer?(input: { chatId: string; messageId: string; answer: string }): Promise<string>;
  },
): ChatStorage {
  return new Proxy(storage, {
    get(target, property) {
      if (property === "finishMessage")
        return (async (messageId, final) => {
          if (final.status !== "complete" || !final.parts || !input.farewellMessage.trim()) return target.finishMessage(messageId, final);
          const message = await target.getMessage(messageId);
          const closing = message ? appClosingAfter(await input.summaryOf(message.chatId), input.farewellMessage) : null;
          if (!message || !closing) return target.finishMessage(messageId, final);
          const answer = closing.answer && input.checkedAnswer ? await input.checkedAnswer({ chatId: message.chatId, messageId, answer: closing.answer }) : closing.answer;
          return target.finishMessage(messageId, { ...final, parts: replaceReplyText(final.parts, appClosingText({ ...closing, answer })) });
        }) satisfies ChatStorage["finishMessage"];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
