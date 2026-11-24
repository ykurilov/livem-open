import { readFileSync } from "node:fs";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { TOOL_TITLES } from "../agent-log/tool-titles";

/**
 * Справка по интерфейсу приложения для конструктора — `prompts/app-help.md`, темы — заголовки `## `.
 * Не в инструкции: она нужна редко, а каждый запрос нёс бы её целиком. Инструмент читает только нужные темы;
 * их список стоит в схеме инструмента и меняется лишь вместе со справкой, кэш модели не сбивается от хода к ходу.
 */
export function readAppHelp(): Map<string, string> {
  const text = readFileSync(path.join(process.cwd(), "prompts", "app-help.md"), "utf8");
  const help = new Map<string, string>();
  for (const section of text.split(/^## /m).slice(1)) {
    const newline = section.indexOf("\n");
    const title = section.slice(0, newline).trim();
    if (title) help.set(title, section.slice(newline + 1).trim());
  }
  return help;
}

export function appHelpTopics(help: Map<string, string>): string[] {
  return [...help.keys()];
}

let cached: Map<string, string> | undefined;
/** Файл справки читается один раз за жизнь процесса: после правки справки приложение перезапускается выпуском. */
const appHelp = () => (cached ??= readAppHelp());

export function createAppHelpTool() {
  const help = appHelp();
  const topics = appHelpTopics(help) as [string, ...string[]];
  return tool({
    title: TOOL_TITLES.app_help,
    description:
      "Справка по интерфейсу приложения: где что находится, как называются разделы, вкладки и кнопки, что нажать, какие ограничения. " +
      "Выбирай только нужные темы.",
    inputSchema: z.strictObject({ topics: z.array(z.enum(topics)).min(1).max(4) }),
    execute: async ({ topics: asked }) => ({
      ok: true,
      text: asked.map((topic) => `## ${topic}\n${help.get(topic)}`).join("\n\n"),
    }),
  });
}
