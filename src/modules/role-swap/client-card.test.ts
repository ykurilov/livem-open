import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { DirectModel } from "../platform/direct-model";
import { inventClientCard } from "./client-card";

function modelAnswering(text: string) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      return {
        content: text ? [{ type: "text", text }] : [],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const direct: DirectModel = { providerId: "test", model, price: undefined, providerOptions: {}, headers: undefined };
  return { direct, calls };
}

const promptText = (call: LanguageModelV4CallOptions) =>
  call.prompt
    .map((message) => (typeof message.content === "string" ? message.content : message.content.map((part) => ("text" in part ? part.text : "")).join("\n")))
    .join("\n");

const lead = { name: "Как выбрать велосипед", cardDescription: "Подбор под рост и бюджет", clientPortrait: "Взрослые новички, пишут коротко, боятся переплатить" };

describe("карточка клиента", () => {
  it("в запрос идут название, описание, «Описание клиентов», «Кто клиент» и прошлые карточки; ответ — без лишних пробелов", async () => {
    const { direct, calls } = modelAnswering("  Ольга, 42 года, едет на работу.  ");
    const card = await inventClientCard({ direct, lead, brief: "Студент без денег", previousCards: ["Пётр, пенсионер", "Анна, мама двоих детей"] });
    expect(card).toBe("Ольга, 42 года, едет на работу.");
    expect(calls).toHaveLength(1);
    const text = promptText(calls[0]!);
    for (const part of [lead.name, lead.cardDescription, lead.clientPortrait, "Студент без денег", "Пётр, пенсионер", "Анна, мама двоих детей"]) expect(text).toContain(part);
  });

  it("пустые части не попадают в запрос", async () => {
    const withAll = modelAnswering("Карточка");
    await inventClientCard({ direct: withAll.direct, lead, brief: "Студент", previousCards: ["Пётр"] });
    const bare = modelAnswering("Карточка");
    await inventClientCard({ direct: bare.direct, lead: { name: lead.name, cardDescription: " ", clientPortrait: "" }, brief: "  ", previousCards: [] });
    const full = promptText(withAll.calls[0]!);
    const short = promptText(bare.calls[0]!);
    expect(short).toContain(lead.name);
    expect(short.length).toBeLessThan(full.length);
    // Заголовки частей, которых нет, тоже не попадают
    const fullLines = new Set(full.split("\n"));
    const headersOnlyInFull = [...fullLines].filter((line) => line.endsWith(":") && !short.includes(line));
    expect(headersOnlyInFull.length).toBeGreaterThanOrEqual(4);
    expect(short).not.toMatch(/:\n\s*(\n|$)/);
  });

  it("пустой ответ модели — ошибка", async () => {
    const { direct } = modelAnswering("   ");
    await expect(inventClientCard({ direct, lead, brief: null, previousCards: [] })).rejects.toThrow();
  });
});
