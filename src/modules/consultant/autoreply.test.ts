import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { suggestClientReply } from "./autoreply";
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

const lead = { name: "Как выбрать велосипед", cardDescription: "" };

describe("«Автоответ»", () => {
  it("реплика модели уходит без лишних пробелов", async () => {
    expect(await suggestClientReply({ direct: modelAnswering("  А сколько стоит?  "), lead, branch: [] })).toBe("А сколько стоит?");
  });

  it("пустой ответ модели — ошибка, а не тихий успех без отправки", async () => {
    await expect(suggestClientReply({ direct: modelAnswering("   "), lead, branch: [] })).rejects.toThrow();
  });
});
