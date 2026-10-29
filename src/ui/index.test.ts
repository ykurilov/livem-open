import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Общий вход `@/ui` берут почти все страницы кабинета. Модуль с "use client" отсюда попадает в клиентский код каждой
 * из них, даже если страница его не рисует: чат-оформление через `@/ui` добавляло настройкам около мегабайта.
 */
describe("общий вход @/ui", () => {
  it("не тянет оформление чата: его берут напрямую только страницы с перепиской", () => {
    const index = readFileSync(join(__dirname, "index.ts"), "utf8");
    const modules = [...index.matchAll(/from "\.\/([\w-]+)"/g)].flatMap((match) => (match[1] ? [match[1]] : []));
    const source = (name: string) => readFileSync(join(__dirname, existsSync(join(__dirname, `${name}.tsx`)) ? `${name}.tsx` : `${name}.ts`), "utf8");
    const withChatSkin = modules.filter((name) => source(name).includes("@ykurilov/agent-chat-skin-oduvanchik"));
    expect(withChatSkin).toEqual([]);
  });
});
