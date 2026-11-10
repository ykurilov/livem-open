import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { claimsSaved, guardSaveClaims, SAVE_CLAIM_NOTE } from "./save-claim";

describe("ответ конструктора говорит, что настройка сохранена", () => {
  it("«записал», «добавил», «поменял», «настроил» от первого лица и «Готово» в начале фразы — да", () => {
    for (const text of [
      "Записал это в инструкцию.",
      "Про марафон добавил — разборы каждую неделю.",
      "Вернёмся к встрече. Бесплатно 20 минут — записал.",
      "Поэтому я настроил его говорить по дням недели.",
      "Готово: цену 12 000 бот называет прямо.",
      "Поменял приветствие.",
      "Вписал, что происходит на выезде.",
      "Завёл поля — телефон, адрес, тип квартиры.",
      "Завела поле «Город».",
      "Создал поле для бюджета.",
      "Подключил поле «Ниша» к карточке.",
    ])
      expect(claimsSaved(text), text).toBe(true);
  });

  it("намерение, предложение, чужие действия и «готово» не о сохранении — нет", () => {
    for (const text of [
      "Зафиксирую это в инструкции.",
      "Могу вписать так: «Тут вы не бросаете на полпути». Подойдёт?",
      "Например, чтобы он записался на бесплатный пробный урок.",
      "Как вернётесь — проверьте тестовый разговор, и всё будет готово к публикации.",
      "Часть формулировок не смогу вписать — объясню.",
      "Понял: сидячая работа и брошенные видео. Как проходит пробное занятие?",
      "Понял, удачи! Настройки сохранены, всё записано — вернётесь, всё будет на месте.",
      "Пока ничего не записал — жду вашего согласия.",
      "Инструкцию ещё не поменял.",
      "Записал бы так, если согласны.",
    ])
      expect(claimsSaved(text), text).toBe(false);
  });

  it("пометка не толкает записать без согласия эксперта", () => {
    expect(SAVE_CLAIM_NOTE).toMatch(/соглас/);
  });
});

type Part = LanguageModelV4StreamPart;
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish: Part = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage };

/** Поток модели, который тест дописывает по кускам. */
function openStream() {
  let controller!: ReadableStreamDefaultController<Part>;
  const stream = new ReadableStream<Part>({ start: (c) => void (controller = c) });
  return { stream, write: (...parts: Part[]) => parts.forEach((part) => controller.enqueue(part)), close: () => controller.close() };
}

const textParts = (text: string): Part[] => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }];
const closedStream = (...parts: Part[]) => new ReadableStream<Part>({ start: (c) => (parts.forEach((part) => c.enqueue(part)), c.close()) });

/** Модель конструктора под проверкой «Записал»: первый запрос — `first`, повторный — `again`. */
function guarded(first: ReadableStream<Part>, again: () => ReadableStream<Part> = () => closedStream(...textParts("Не сохранилось."), finish)) {
  const prompts: LanguageModelV4CallOptions["prompt"][] = [];
  const inner = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt);
      return { stream: prompts.length === 1 ? first : again() };
    },
  });
  const model = guardSaveClaims(inner) as LanguageModelV4;
  return { prompts, start: () => model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Что у меня в сценарии?" }] }] }) };
}

/** Что видит эксперт: `shownSoFar` — текст, пришедший, пока модель ещё пишет (за 50 мс), `rest` — всё до конца. */
function expertView(stream: ReadableStream<Part>) {
  const reader = stream.getReader();
  // Чтение, не дождавшееся конца паузы, не теряется: следующий вызов дождётся его же
  let pending: Promise<ReadableStreamReadResult<Part>> | undefined;
  const read = async () => {
    const next = await (pending ??= reader.read());
    pending = undefined;
    return next;
  };
  return {
    async shownSoFar(): Promise<string> {
      let text = "";
      for (;;) {
        const next = await Promise.race([read(), new Promise<"ждёт">((resolve) => setTimeout(() => resolve("ждёт"), 50))]);
        if (next === "ждёт" || next.done) return text;
        if (next.value.type === "text-delta") text += next.value.delta;
      }
    },
    async rest(): Promise<Part[]> {
      const parts: Part[] = [];
      for (let next = await read(); !next.done; next = await read()) parts.push(next.value);
      return parts;
    },
  };
}
const textIn = (parts: Part[]) => parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");

describe("ответ конструктора эксперт видит по ходу печати", () => {
  it("ответ без «записал» идёт по фразам, пока модель ещё пишет", async () => {
    const source = openStream();
    const { prompts, start } = guarded(source.stream);
    const expert = expertView((await start()).stream);
    source.write({ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "В сценарии три шага.\n- Знак" });

    expect(await expert.shownSoFar()).toBe("В сценарии три шага.\n");

    source.write({ type: "text-delta", id: "t", delta: "омство" }, { type: "text-end", id: "t" }, finish);
    source.close();
    expect(textIn(await expert.rest())).toBe("- Знакомство");
    expect(prompts).toHaveLength(1);
  });

  it("фраза с «записал» придерживается; модель отвечает заново после показанного начала, оно не повторяется", async () => {
    const source = openStream();
    const { prompts, start } = guarded(source.stream);
    const expert = expertView((await start()).stream);
    source.write({ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Посмотрел сценарий. Зап" });
    expect(await expert.shownSoFar()).toBe("Посмотрел сценарий. ");

    source.write({ type: "text-delta", id: "t", delta: "исал: встреча бесплатная." }, { type: "text-end", id: "t" }, finish);
    source.close();
    const rest = await expert.rest();

    expect(textIn(rest)).toBe("Не сохранилось.");
    // Начатый текст закрыт до нового ответа
    expect(rest.findIndex((part) => part.type === "text-end")).toBeLessThan(rest.findIndex((part) => part.type === "text-start"));
    const retry = prompts[1]!;
    expect(retry.at(-2)).toEqual({ role: "assistant", content: [{ type: "text", text: "Посмотрел сценарий." }] });
    expect(JSON.stringify(retry.at(-1))).toContain(SAVE_CLAIM_NOTE);
    expect(rest.find((part) => part.type === "finish")).toMatchObject({ usage: { inputTokens: { total: 20 } } });
  });

  it("«Записал» с вызова правки в том же шаге уходит как есть, без повтора", async () => {
    const { prompts, start } = guarded(
      closedStream(...textParts("Записал."), { type: "tool-call", toolCallId: "c", toolName: "edit_lead_magnet", input: "{}" }, finish),
    );
    const parts = await expertView((await start()).stream).rest();
    expect(textIn(parts)).toBe("Записал.");
    expect(parts.some((part) => part.type === "tool-call")).toBe(true);
    expect(prompts).toHaveLength(1);
  });
});
