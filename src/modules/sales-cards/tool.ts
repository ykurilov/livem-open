import type { AppStateAccess } from "@ykurilov/agent-chat-core";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { SALES_CARD_TOOL, type SalesCard } from "./sales-cards";

export { SALES_CARD_TOOL };

/** Где в состоянии ветки чата лежат id выданных заготовок: правка, перемотка и выбор ветки снимают отметку сами. */
const USED_PATH = "salesCards.used";

const DESCRIPTION =
  "Получить полный текст заготовки эксперта по id из списка заготовок. Вызывай, только когда решил её использовать в этом ответе. " +
  "Ответ скажет, отправить текст дословно или пересказать своими словами. Повторный вызов той же заготовки в разговоре текста не даст.";

const USE = {
  verbatim: "Отправь этот текст человеку дословно, без правок: цены, условия и ссылки — как есть. Связку до или после можно добавить своими словами.",
  ownWords: "Перескажи суть своими словами под этот разговор, коротко. Факты, цифры и ссылки не меняй и новых не добавляй.",
} as const;

function usedIn(state: AppStateAccess | undefined): string[] {
  const used = state?.get(USED_PATH);
  return Array.isArray(used) ? used.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Инструмент заготовок: один и тот же на всех ходах версии (описание без текстов и названий — кэш цел). Выданная
 * заготовка отмечается в состоянии ветки чата; повторный запрос в этом разговоре текста не получает.
 */
export function createSalesCardTool(settings: { salesCards?: readonly SalesCard[] }, state: AppStateAccess | undefined): Tool {
  const cards = new Map((settings.salesCards ?? []).map((card) => [card.id, card]));
  return tool({
    description: DESCRIPTION,
    inputSchema: z.strictObject({ id: z.string().min(1).describe("id заготовки из квадратных скобок списка") }),
    execute: async ({ id }) => {
      const card = cards.get(id.trim().replace(/^\[|\]$/g, ""));
      if (!card) return { ok: false as const, error: "Нет заготовки с таким id: бери id только из списка заготовок." };
      const used = usedIn(state);
      if (used.includes(card.id))
        return { ok: false as const, error: "Эта заготовка уже была в этом разговоре: второй раз её не используй, ответь своими словами." };
      state?.set(USED_PATH, [...used, card.id]);
      return { ok: true as const, text: card.text, use: card.verbatim ? USE.verbatim : USE.ownWords };
    },
  });
}
