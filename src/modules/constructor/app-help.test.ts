import { describe, expect, it } from "vitest";
import { createConstructorTools } from "./tools";
import { appHelpTopics, readAppHelp } from "./app-help";

type HelpTool = { execute(input: { topics: string[] }, options: never): Promise<{ ok: boolean; text?: string; error?: string }> };

describe("справка конструктора по приложению", () => {
  const help = readAppHelp();

  it("темы — заголовки справки, у каждой есть текст", () => {
    const topics = appHelpTopics(help);
    expect(topics).toEqual(expect.arrayContaining(["Ссылки с метками", "Откуда пришли", "Люди", "Публикация и ссылки", "Рассылки"]));
    for (const topic of topics) expect(help.get(topic)!.length).toBeGreaterThan(100);
  });

  it("инструмент app_help перечисляет темы в схеме и отдаёт текст выбранных", async () => {
    const tool = createConstructorTools({} as never, "lead").app_help as unknown as HelpTool & { inputSchema: unknown };
    expect(JSON.stringify(tool.inputSchema)).toContain("Откуда пришли");
    const result = await tool.execute({ topics: ["Ссылки с метками", "Откуда пришли"] }, {} as never);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("__ad_campaign__");
    expect(result.text).toContain("«Откуда пришли»");
    expect(result.text).toMatch(/utm/);
  });
});
