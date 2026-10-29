import { foreignWords, unknownLinks } from "@ykurilov/agent-chat-reply-check";
import { describe, expect, it } from "vitest";
import { linksIn } from "../../../evals/unknown-links";
import { tagProductLinks } from "../purchases/product-links";
import { buildTextLink, MAX_FULL_LINK_CHARS, MAX_LINK_CHARS, textLinkSchema, type TextLink } from "./text-link";
import { createTextLinkTool } from "./tool";

const studioLink: TextLink = textLinkSchema.parse({
  template: "https://appstudio.example.com/?idea={text}&type={type}",
  types: ["game", "app", "site", "tracker", "quiz", "card"],
  maxTextLength: 450,
});
const idea = "Сделай игру (аркаду): кот Мурзик прыгает по крышам, собирает рыбок! Нарисуй всё в одном стиле, добавь конфетти и звук.";

const ideaOf = (link: string) => new URL(link).searchParams.get("idea");

describe("ссылка с подставленным текстом", () => {
  it("текст кодируется целиком и раскодируется в тот же текст; тип — своим параметром", () => {
    const result = buildTextLink(studioLink, { text: idea, type: "game" });
    if (!result.ok) throw new Error(result.error);
    expect(ideaOf(result.link)).toBe(idea.replace(/[()]/g, "").replace(/\.$/, ""));
    expect(new URL(result.link).searchParams.get("type")).toBe("game");
    expect(result.link.startsWith("https://appstudio.example.com/?idea=%D0%A1")).toBe(true);
  });

  it("ссылку в тексте находят целиком: скобок, апострофа и звёздочки в тексте нет, знаков в конце — тоже", () => {
    const result = buildTextLink(studioLink, { text: "Открытка (для мамы)! Её 'день' *сюрприз*.", type: "card" });
    if (!result.ok) throw new Error(result.error);
    expect(result.link).not.toMatch(/[()'*]/);
    expect(ideaOf(result.link)).toBe("Открытка для мамы! Её ’день’ сюрприз");
    // Кавычки кодируются: короткая ссылка уходит в чат, полная модели не видна и копию не обрывает
    const quoted = buildTextLink(studioLink, { text: "Кнопка «Записаться» и \"Отзывы\"" });
    expect(quoted.ok && ideaOf(quoted.link)).toBe("Кнопка «Записаться» и \"Отзывы\"");
    expect(linksIn(`Откройте ссылку: ${result.link}. И нажмите «Собрать».`)).toEqual([result.link]);
    const untyped = buildTextLink(studioLink, { text: "Трекер воды!!!" });
    expect(untyped.ok && linksIn(`Вот: ${untyped.link}.`)).toEqual([untyped.ok && untyped.link]);
  });

  it("ссылка — ровно encodeURIComponent текста: без нестандартных кодов, которые модель «поправит» при переписывании (eval 21.10: %2E → «.»)", () => {
    const result = buildTextLink(studioLink, { text: "Квиз. Пять вопросов, конфетти.", type: "quiz" });
    if (!result.ok) throw new Error(result.error);
    expect(result.link).toBe(`https://appstudio.example.com/?idea=${encodeURIComponent("Квиз. Пять вопросов, конфетти")}&type=quiz`);
  });

  it("без типа параметр type уходит из ссылки; тип не из списка — ошибка со списком", () => {
    const plain = buildTextLink(studioLink, { text: "Трекер воды" });
    expect(plain.ok && plain.link).toBe("https://appstudio.example.com/?idea=%D0%A2%D1%80%D0%B5%D0%BA%D0%B5%D1%80%20%D0%B2%D0%BE%D0%B4%D1%8B");
    const wrong = buildTextLink(studioLink, { text: "Трекер воды", type: "website" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/game, app, site, tracker, quiz, card/);
  });

  it("длинный текст — понятная ошибка с просьбой сократить: по пределу настроек и по длине ссылки для мессенджера", () => {
    const long = buildTextLink(studioLink, { text: "а".repeat(451) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toMatch(/451.*450.*сократи/is);
    const roomy = textLinkSchema.parse({ ...studioLink, maxTextLength: 2000 });
    const tooLongLink = buildTextLink(roomy, { text: "я".repeat(600) });
    expect(tooLongLink.ok).toBe(false);
    if (!tooLongLink.ok) expect(tooLongLink.error).toMatch(new RegExp(`${MAX_LINK_CHARS}.*сократи`, "is"));
  });

  it("текст из одних кавычек или знаков — после очистки пусто: ошибка, а не пустая ссылка (ревью 21.10)", () => {
    for (const text of ["()", "()!!!", "**", "...", "а."]) {
      const result = buildTextLink(studioLink, { text });
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/слишком короткий|пуст/i);
    }
  });

  it("шаблон с учётными данными в адресе не принимается; # в шаблоне разбирается как часть адреса", () => {
    expect(textLinkSchema.safeParse({ template: "https://appstudio.example.com@evil.com/?idea={text}", types: [], maxTextLength: 300 }).success).toBe(false);
    expect(textLinkSchema.safeParse({ template: "https://user:pass@site.ru/?idea={text}", types: [], maxTextLength: 300 }).success).toBe(false);
    const withHash = textLinkSchema.parse({ template: "https://site.ru/app?idea={text}#start", types: [], maxTextLength: 300 });
    const built = buildTextLink(withHash, { text: "Кот" });
    expect(built.ok && built.link).toBe("https://site.ru/app?idea=%D0%9A%D0%BE%D1%82#start");
    expect(textLinkSchema.safeParse({ template: "https://site.ru/app#x?idea={text}", types: [], maxTextLength: 300 }).success).toBe(false);
  });

  it("шаблон: адрес https, {text} — значение параметра ровно один раз, других подстановок нет", () => {
    expect(textLinkSchema.safeParse({ template: "https://site.ru/?q={text}", types: [], maxTextLength: 300 }).success).toBe(true);
    for (const template of ["http//site.ru/?q={text}", "https://site.ru/{text}", "https://site.ru/?q=1", "https://site.ru/?q={text}&x={name}", "https://site.ru/?q={text}&r={text}"])
      expect(textLinkSchema.safeParse({ template, types: [], maxTextLength: 300 }).success, template).toBe(false);
  });

  it("метки ссылок продукта её не трогают: другой адрес", () => {
    const result = buildTextLink(studioLink, { text: idea, type: "game" });
    if (!result.ok) throw new Error(result.error);
    const text = `Откройте: ${result.link}`;
    const products = [{ url: "https://school.example.com/ai_agent_course", title: "Свой ИИ-агент", campaign: "ai_agent_course" }];
    expect(tagProductLinks(text, products, { medium: "telegram", content: "abc123" })).toBe(text);
    const short = "Откройте ссылку и нажмите «Собрать»: https://lm.example.com/i/K7mP2xQ";
    expect(tagProductLinks(short, products, { medium: "telegram", content: "abc123" })).toBe(short);
  });

  it("проверки ответа SDK пропускают ссылку из результата инструмента: она не «выдуманная», латиница в ней — не чужие слова", async () => {
    const tool = createTextLinkTool(studioLink);
    const output = await tool.execute!({ text: idea, type: "game" }, { toolCallId: "1", messages: [] } as never);
    const link = (output as { link: string }).link;
    const reply = `Вот ваша идея — откройте ссылку и нажмите «Собрать»:\n${link}`;
    const seenTexts = ["Инструкция: ссылка на сервис https://appstudio.example.com/", JSON.stringify(output)];
    const rewrite = async () => {
      throw new Error("переписывать не нужно");
    };
    const context = { text: reply, ownerId: "o", chatId: "c", messageId: "m", seenTexts, rewrite };
    expect(await unknownLinks()(context)).toBeUndefined();
    expect(await foreignWords({ script: "cyrillic" })(context)).toBeUndefined();
  });

  it("фраза из настроек, что делать по ссылке, приходит в ответе инструмента дословно", async () => {
    const tool = createTextLinkTool({ ...studioLink, say: "Откройте ссылку и нажмите «Собрать» — идея уже вписана." });
    const output = await tool.execute!({ text: "Квиз про котов" }, { toolCallId: "1", messages: [] } as never);
    expect((output as { next: string }).next).toContain("«Откройте ссылку и нажмите «Собрать» — идея уже вписана.»");
  });

  it("с сокращателем инструмент отдаёт модели короткую ссылку, полная уходит в хранилище; текст до 1200 знаков проходит", async () => {
    const roomy = textLinkSchema.parse({ ...studioLink, maxTextLength: 1200 });
    const saved: string[] = [];
    const tool = createTextLinkTool(roomy, async (target) => {
      saved.push(target);
      return "https://lm.example.ru/i/K7mP2xQ";
    });
    const text = "Тренажёр английских слов для детей с картинками и конфетти ".repeat(20).slice(0, 1150);
    const output = await tool.execute!({ text, type: "quiz" }, { toolCallId: "1", messages: [] } as never);
    expect(output).toMatchObject({ ok: true, link: "https://lm.example.ru/i/K7mP2xQ" });
    expect(ideaOf(saved[0]!)).toBe(text.trim());
    expect(JSON.stringify(output)).not.toContain("%D0");
  });

  it("с сокращателем предел — длина полной ссылки для сервера (~8 КБ), а не мессенджера", () => {
    const roomy = textLinkSchema.parse({ ...studioLink, maxTextLength: 2000 });
    expect(buildTextLink(roomy, { text: "я".repeat(600) }, { maxLinkChars: MAX_FULL_LINK_CHARS }).ok).toBe(true);
    const tooLong = buildTextLink(roomy, { text: "я".repeat(1500) }, { maxLinkChars: MAX_FULL_LINK_CHARS });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toMatch(/сократи/i);
  });

  it("инструмент: тип — из списка настроек; ответ говорит вставить ссылку как есть", async () => {
    const tool = createTextLinkTool(studioLink);
    expect(tool.description).toMatch(/вставь[^.]*как есть/i);
    const output = await tool.execute!({ text: "Квиз про котов", type: "quiz" }, { toolCallId: "1", messages: [] } as never);
    expect(output).toMatchObject({ ok: true });
    // eval 21.10: «Держите ссылку — идея уже вписана» без «нажмите «Собрать»» — ответ инструмента напоминает сказать, что делать
    expect((output as { next: string }).next).toMatch(/как есть[^.]*скажи[^.]*что по ней сделать/i);
    expect(ideaOf((output as { link: string }).link)).toBe("Квиз про котов");
  });
});
