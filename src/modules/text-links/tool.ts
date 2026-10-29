import { tool, type Tool } from "ai";
import { z } from "zod";
import { buildTextLink, MAX_FULL_LINK_CHARS, type TextLink } from "./text-link";

export const TEXT_LINK_TOOL = "text_link";

/** Полная ссылка → короткая `/i/<код>` (хранилище `text_short_links`). */
export type ShortenLink = (target: string) => Promise<string>;

/**
 * Инструмент `text_link`: описание и схема зависят только от настроек версии — кэш цел. С `shorten` модель получает
 * короткую ссылку из латиницы, полная остаётся у нас: в истории и в чате нет тысяч знаков процентов. Без него (нет
 * публичного адреса приложения) — полная, в пределах сообщения мессенджера.
 */
export function createTextLinkTool(config: TextLink, shorten?: ShortenLink): Tool {
  const [first, ...rest] = config.types;
  const inputSchema = z.strictObject({
    text: z.string().describe("Текст, который встанет в ссылку"),
    type: (first ? z.enum([first, ...rest]) : z.string()).optional().describe(first ? `Тип: ${config.types.join(", ")}; можно не задавать` : "Не задавай"),
  });
  return tool({
    description:
      `Собрать ссылку с подставленным текстом по шаблону ${config.template}. Текст — до ${config.maxTextLength} знаков, обычными словами. ` +
      "Вызывай до ответа, без текста перед вызовом; полученную ссылку вставь в ответ как есть, целиком, отдельной строкой. Сам ссылку не собирай и не меняй.",
    inputSchema,
    execute: async (input: z.infer<typeof inputSchema>) => {
      const built = buildTextLink(config, input, shorten ? { maxLinkChars: MAX_FULL_LINK_CHARS } : {});
      if (!built.ok) return built;
      const link = shorten ? await shorten(built.link) : built.link;
      const say = config.say ? `скажи человеку «${config.say}»` : "скажи человеку, что по ней сделать, — как велит инструкция";
      return { ok: true as const, link, next: `Вставь эту ссылку в ответ как есть, целиком, отдельной строкой, и ${say}` };
    },
  });
}
