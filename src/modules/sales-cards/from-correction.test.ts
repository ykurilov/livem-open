import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { DirectModel } from "../platform/direct-model";
import { cardFromCorrection, parseCardSuggestion } from "./from-correction";
import { settingsWithCards } from "./test-settings";

function modelAnswering(text: string, prompts: unknown[] = []): DirectModel {
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  return { providerId: "test", model, price: undefined, providerOptions: {}, headers: undefined };
}

const settings = settingsWithCards([]);
const correction = {
  stageId: "sale",
  correctedText: "Понимаю. Есть рассрочка на 3 месяца без переплаты.",
  reason: "Не спорить о цене",
  context: [
    { role: "assistant" as const, text: "Курс стоит 9 900 ₽." },
    { role: "user" as const, text: "Дороговато для меня" },
  ],
};

describe("заготовка из исправленного ответа", () => {
  it("текст — вариант эксперта, этап — где прозвучал ответ, название и повод — от модели", async () => {
    const prompts: unknown[] = [];
    const card = await cardFromCorrection({ direct: modelAnswering('{"title":"Дорого","when":"Человеку дорого"}', prompts), settings, correction });
    expect(card).toEqual({ stateId: "sale", title: "Дорого", when: "Человеку дорого", text: correction.correctedText, verbatim: false });
    // Модель видит, что ответили и на что
    expect(JSON.stringify(prompts)).toContain("Дороговато для меня");
    expect(JSON.stringify(prompts)).toContain("рассрочка на 3 месяца");
  });

  it("этапа больше нет — общая шпаргалка", async () => {
    const card = await cardFromCorrection({ direct: modelAnswering('{"title":"Дорого","when":"Дорого"}'), settings, correction: { ...correction, stageId: "gone" } });
    expect(card.stateId).toBeNull();
  });

  it("модель ответила не по форме — поля пустые, эксперт впишет сам", async () => {
    const card = await cardFromCorrection({ direct: modelAnswering("не знаю"), settings, correction });
    expect(card).toMatchObject({ title: "", when: "", text: correction.correctedText });
  });

  it("разбор ответа модели: JSON внутри текста, лишние пробелы, длина в пределах", () => {
    expect(parseCardSuggestion('Вот:\n```json\n{"title":"  Дорого ","when":"Сомневается в цене"}\n```')).toEqual({ title: "Дорого", when: "Сомневается в цене" });
    expect(parseCardSuggestion(`{"title":"${"а".repeat(200)}","when":"б"}`)!.title.length).toBeLessThanOrEqual(80);
    expect(parseCardSuggestion("{}")).toBeNull();
  });
});
