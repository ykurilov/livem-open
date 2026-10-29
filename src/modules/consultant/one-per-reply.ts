import type { AgentToolsModel } from "@ykurilov/agent-chat-core";
import type { ToolSet } from "ai";

/** Ответов, которые помним одновременно: идущих ходов меньше, старые вытесняются. */
const REMEMBERED_REPLIES = 1000;

/**
 * Не больше одного показа за ответ — гарантия кода, а не только инструкции. Второй вызов `toolName` того же ответа
 * получает отказ, и карточки в «Проверке» у него нет. Ответ узнаём по `model.turnId`: он один на все попытки хода.
 * Показ засчитан, только если в результате есть `shownKey`; отказ или ошибка инструмента место освобождают.
 */
export function onePerReply(toolName: string, shownKey: string, refusal: string) {
  const repliesWithShow = new Set<string>();

  const remember = (turnId: string) => {
    repliesWithShow.add(turnId);
    if (repliesWithShow.size > REMEMBERED_REPLIES) repliesWithShow.delete(repliesWithShow.values().next().value!);
  };

  return function limit<T extends ToolSet>(tools: T, model: AgentToolsModel): T {
    const show = tools[toolName];
    const turnId = model.turnId;
    if (!show?.execute || !turnId) return tools;
    const execute = show.execute;
    return {
      ...tools,
      [toolName]: {
        ...show,
        execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
          // Место занимается до ожидания: два вызова в одном шаге не проскочат вместе
          if (repliesWithShow.has(turnId)) return { отказ: refusal };
          remember(turnId);
          try {
            const output = await execute(input, options);
            if (!(output && typeof output === "object" && shownKey in output)) repliesWithShow.delete(turnId);
            return output;
          } catch (error) {
            repliesWithShow.delete(turnId);
            throw error;
          }
        },
      },
    };
  };
}

/** Не больше одного ролика за ответ. */
export const oneVideoPerReply = () => onePerReply("show_video", "видео", "В этом ответе ролик уже показан. Второй не показывай: один ролик за ответ.");

/** Не больше одной картинки за ответ. */
export const oneImagePerReply = () =>
  onePerReply("show_image", "картинка", "В этом ответе картинка уже показана. Вторую не показывай: одна картинка за ответ.");
