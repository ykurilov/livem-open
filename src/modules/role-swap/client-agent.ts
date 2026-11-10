// Агент-клиент «Поменяемся ролями»: роль одна на все разговоры, кто именно клиент — блок контекста, застывший в первом ходе.
import type { AgentToolsSource, ContextBlock } from "@ykurilov/agent-chat-core";
import { tool } from "ai";
import { z } from "zod";
import { BOT_ROLE, CLIENT_PLAY_RULES, CLIENT_ROLE_START } from "../consultant/client-role";

export const ROLE_SWAP_CLIENT_BLOCK_KEY = "role-swap:client";
/** Имя — как у персонажей eval: клиент уходит одинаково и там, и здесь. */
export const CLIENT_LEAVE_TOOL = "leave_chat";
/** Закрытие чата уходом клиента: текст видит эксперт вместо поля ввода. */
export const CLIENT_LEFT_CLOSURE = { code: "client_left", message: "Клиент закончил разговор" } as const;

const CLIENT_INSTRUCTIONS = `${CLIENT_ROLE_START}
Тема бота и кто ты — в сведениях о разговоре ниже. ${BOT_ROLE}

${CLIENT_PLAY_RULES}
- Ты знаешь только то, что знал бы такой человек, и то, что тебе написали в этом чате. Настроек бота ты не видишь.
- Отвечай на каждое сообщение бота одной репликой.
- Весь разговор держись своей карточки: тот же человек, та же ситуация, та же манера письма.
- Не подыгрывай боту. Соглашайся, только когда тебя и правда убедили; сомнения из карточки высказывай так, как высказал бы этот человек.
- Пишешь только текстом: фото и файлы прислать не можешь. Обещанное ботом считай полученным, только если оно есть прямо в его сообщении.
- Когда захочешь закончить разговор — тебе всё ясно, надоело, обиделся или бот попрощался, — молча вызови ${CLIENT_LEAVE_TOOL}. Перед вызовом можешь написать последнюю реплику, а можешь пропасть, не прощаясь.`;

/** Инструкция агента-клиента: одна для любых лидмагнитов, начало запроса не меняется. */
export function clientInstructions(): string {
  return CLIENT_INSTRUCTIONS;
}

/** Тема бота и карточка клиента: пишутся в первый ход и дальше не меняются. */
export function clientCardBlock(conversation: { topic: string; clientCard: string }): ContextBlock {
  return { key: ROLE_SWAP_CLIENT_BLOCK_KEY, text: `Тема бота: ${conversation.topic}\n\nКто ты:\n${conversation.clientCard}` };
}

/** Тема бота для клиента: название лидмагнита и его описание, если оно есть. */
export function clientTopic(lead: { name: string; cardDescription: string }): string {
  const description = lead.cardDescription.trim();
  return description ? `${lead.name} (${description})` : lead.name;
}

/** Инструменты клиента: только уход. Чат закрывается, приложение отмечает конец разговора. */
export function clientTools(onLeave: (chatId: string) => Promise<void>): AgentToolsSource {
  return (model) => ({
    [CLIENT_LEAVE_TOOL]: tool({
      description: "Закончить разговор с ботом и уйти из чата",
      inputSchema: z.object({
        reason: z.string().describe("Почему уходишь"),
        saidGoodbye: z.boolean().describe("true — твоя последняя реплика была прощанием или отказом; false — пропадаешь, не прощаясь"),
      }),
      execute: async () => {
        model.closeChat?.(CLIENT_LEFT_CLOSURE);
        await onLeave(model.chatId);
        return "Разговор закончен. Больше ничего не пиши.";
      },
    }),
  });
}
