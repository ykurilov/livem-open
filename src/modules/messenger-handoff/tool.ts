import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { MessengerHandoffSetting } from "./setting";

/** Признак хода (`agent.viewer`): человек сейчас в веб-чате. */
export const IN_WEB_CHAT = "inWebChat";

export const OFFER_MESSENGER_TOOL = "offer_messenger";

/** Что инструменту перехода нужно от приложения: где человек и показать кнопки. */
export interface MessengerHandoffPort {
  /** Человек этого чата сейчас в веб-чате (живой разговор) или в «Проверке» до нажатия кнопки. */
  inWebChat(chat: { ownerId: string; chatId: string }): Promise<boolean>;
  /** Показать кнопки мессенджеров; названия мессенджеров или отказ. */
  offer(chat: { ownerId: string; chatId: string }): Promise<{ ok: true; buttons: ReadonlyArray<{ title: string }> } | { ok: false; reason: string }>;
}

const REFUSALS: Record<string, string> = {
  taken: "Человек уже перешёл в мессенджер.",
  no_bots: "Лидмагнит не опубликован ни в одном из выбранных мессенджеров: кнопок нет, разговор идёт здесь.",
  off: "Переход в мессенджер выключен.",
  not_web: "Человек не в веб-чате: переход не нужен.",
};

/** Инструмент `offer_messenger`: описание неизменно для версии лидмагнита — меняется только вместе с настройкой эксперта. */
export function createMessengerHandoffTool(setting: MessengerHandoffSetting, offer: () => ReturnType<MessengerHandoffPort["offer"]>): ToolSet {
  return {
    [OFFER_MESSENGER_TOOL]: tool({
      description:
        "Показать человеку в веб-чате кнопки мессенджеров, чтобы продолжить разговор там. После вызова поле ввода веб-чата закрыто: " +
        "человек может только нажать кнопку, а в мессенджере ты напишешь ему первым. Эксперт хочет перевести человека в мессенджер; " +
        "это его решение, а не твоё. Как только в разговоре выполнено его условие, вызови инструмент в этом же ходе, не откладывай и не взвешивай, " +
        "нужно ли. До этого не вызывай. Условие эксперта: " +
        setting.when.trim(),
      inputSchema: z.object({}),
      execute: async () => {
        const result = await offer();
        if (!result.ok) return { ok: false as const, error: REFUSALS[result.reason] ?? "Кнопки не показаны." };
        return {
          ok: true as const,
          next: `Под твоим ответом человек видит кнопки: ${result.buttons.map((button) => button.title).join(", ")}. Объясни, зачем перейти и что нажать.`,
        };
      },
    }),
  };
}
