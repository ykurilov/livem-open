import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { autoreplyInstructions, suggestClientReply } from "./autoreply";
import type { DirectModel } from "../platform/direct-model";

function modelAnswering(text: string): DirectModel {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: text ? [{ type: "text", text }] : [],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  return { providerId: "test", model, price: undefined, providerOptions: {}, headers: undefined };
}

const lead = { name: "Как выбрать велосипед", cardDescription: "", testClient: null };

describe("«Автоответ»", () => {
  it("реплика модели уходит без лишних пробелов", async () => {
    expect(await suggestClientReply({ direct: modelAnswering("  А сколько стоит?  "), lead, branch: [] })).toBe("А сколько стоит?");
  });

  it("пустой ответ модели — ошибка, а не тихий успех без отправки", async () => {
    await expect(suggestClientReply({ direct: modelAnswering("   "), lead, branch: [] })).rejects.toThrow();
  });
});

describe("«Автоответ»: клиент для проверки", () => {
  it("без описания клиент придумывает себя сам, как раньше", () => {
    const instructions = autoreplyInstructions(lead);
    expect(instructions).toContain("придумай себе правдоподобную ситуацию");
  });

  it("с описанием модель играет описанного клиента", () => {
    const instructions = autoreplyInstructions({ ...lead, testClient: "  Пенсионер, ездит на дачу, боится сложной техники.  " });
    expect(instructions).toContain("Пенсионер, ездит на дачу, боится сложной техники.");
    expect(instructions).not.toContain("придумай себе правдоподобную ситуацию");
  });

  it("описание — в конце инструкции: общая часть до него не меняется", () => {
    const plain = autoreplyInstructions(lead);
    const described = autoreplyInstructions({ ...lead, testClient: "Студент" });
    const shared = plain.slice(0, plain.indexOf("- Кто ты"));
    expect(described.startsWith(shared)).toBe(true);
    expect(described.trimEnd().endsWith("Студент")).toBe(true);
  });
});
