import { describe, expect, it } from "vitest";
import { linksIn, unknownLinksIn } from "./unknown-links";

describe("ссылки в ответе консультанта", () => {
  it("находит http(s)://, www., домен с путём и t.me/…; знаки препинания в конце — не часть ссылки; почта и @имя — не ссылки", () => {
    expect(
      linksIn("Запись: https://yoga-anna.ru/probnoe. Ещё www.anna.ru, t.me/anna_bot и bit.ly/x1? Почта anna@mail.ru, @anna_coach, сайт anna.ru"),
    ).toEqual(["https://yoga-anna.ru/probnoe", "www.anna.ru", "t.me/anna_bot", "bit.ly/x1"]);
  });

  it("ссылка из знакомых текстов — законна; то же без https:// или с ним — тоже; выдуманная или изменённая — нет", () => {
    const known = ["Ссылка на запись: https://yoga-anna.ru/probnoe", "Канал t.me/anna_yoga"];
    expect(unknownLinksIn("Вот запись: https://yoga-anna.ru/probnoe", known)).toEqual([]);
    expect(unknownLinksIn("Вот запись: yoga-anna.ru/probnoe и https://t.me/anna_yoga", known)).toEqual([]);
    expect(unknownLinksIn("Вот: https://yoga-anna.ru/probnoe-2 и https://yoga-anna.ru/zapis", known)).toEqual([
      "https://yoga-anna.ru/probnoe-2",
      "https://yoga-anna.ru/zapis",
    ]);
  });

  it("ссылка продукта с utm-метками приложения — та же ссылка; другие параметры — нет", () => {
    const known = ["Купить: https://school.example.com/ai_agent_course"];
    const tagged = "https://school.example.com/ai_agent_course?utm_source=vasily&utm_medium=telegram&utm_campaign=ai_agent_course&utm_content=k7m2p9qa";
    expect(unknownLinksIn(`Курс: ${tagged}.`, known)).toEqual([]);
    expect(unknownLinksIn("https://school.example.com/ai_agent_course?promo=1", known)).toEqual(["https://school.example.com/ai_agent_course?promo=1"]);
  });
});

describe("короткий адрес приложения", () => {
  const instruction = "Приложение открывается по ссылке вида адрес.apps.example.com. Сервис: https://appstudio.example.com/";

  it("человек прислал адрес без схемы — ссылка с https:// на него законна", () => {
    expect(unknownLinksIn("Откройте https://sveta-nails.apps.example.com и проверьте", [instruction, "Вот: sveta-nails.apps.example.com"])).toEqual([]);
  });

  it("голое имя из слов человека на домене приложений из инструкции — законно; другое имя или чужой домен — нет", () => {
    const known = [instruction, "Опубликовала, адрес sveta-nails"];
    expect(unknownLinksIn("Ваша ссылка: https://sveta-nails.apps.example.com/", known)).toEqual([]);
    expect(unknownLinksIn("Ваша ссылка: https://sveta.apps.example.com/", known)).toEqual(["https://sveta.apps.example.com/"]);
    expect(unknownLinksIn("Ваша ссылка: https://sveta-nails.appstudio.example.com/", known)).toEqual(["https://sveta-nails.appstudio.example.com/"]);
  });
});
