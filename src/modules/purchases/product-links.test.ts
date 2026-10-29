import { describe, expect, it } from "vitest";
import { tagProductLinks, type ProductLink } from "./product-links";

const COURSE: ProductLink = { url: "https://school.example.com/ai_agent_course", title: "Свой ИИ-агент", campaign: "ai_agent_course" };
const TAG = { medium: "telegram", content: "k7m2p9qa" };
const TAGGED = "https://school.example.com/ai_agent_course?utm_source=vasily&utm_medium=telegram&utm_campaign=ai_agent_course&utm_content=k7m2p9qa";

describe("tagProductLinks", () => {
  it("дописывает метки к ссылке продукта, знаки после ссылки остаются на месте", () => {
    expect(tagProductLinks(`Купить: ${COURSE.url}. Там оба тарифа.`, [COURSE], TAG)).toBe(`Купить: ${TAGGED}. Там оба тарифа.`);
  });

  it("ссылка в скобках и в конце строки", () => {
    expect(tagProductLinks(`(${COURSE.url})`, [COURSE], TAG)).toBe(`(${TAGGED})`);
    expect(tagProductLinks(`${COURSE.url}/`, [COURSE], TAG)).toBe(TAGGED.replace("ai_agent_course?", "ai_agent_course/?"));
  });

  it("без схемы и с www — тоже ссылка продукта", () => {
    expect(tagProductLinks("school.example.com/ai_agent_course", [COURSE], TAG)).toBe(TAGGED.replace("https://", ""));
    expect(tagProductLinks("https://www.school.example.com/ai_agent_course", [COURSE], TAG)).toBe(TAGGED.replace("https://", "https://www."));
  });

  it("свои параметры ссылки сохраняются, старые метки заменяются нашими", () => {
    const text = `${COURSE.url}?tariff=main&utm_content=old&utm_source=vk`;
    expect(tagProductLinks(text, [COURSE], TAG)).toBe(
      `${COURSE.url}?tariff=main&utm_source=vasily&utm_medium=telegram&utm_campaign=ai_agent_course&utm_content=k7m2p9qa`,
    );
  });

  it("якорь остаётся последним", () => {
    expect(tagProductLinks(`${COURSE.url}#tariffs`, [COURSE], TAG)).toBe(`${TAGGED}#tariffs`);
  });

  it("чужие ссылки и другой путь того же сайта не трогает", () => {
    const text = "https://appstudio.example.com/ и https://school.example.com/ai_agent_coursex и https://school.example.com/other";
    expect(tagProductLinks(text, [COURSE], TAG)).toBe(text);
  });

  it("страница глубже пути продукта — тоже продукт", () => {
    expect(tagProductLinks(`${COURSE.url}/pay`, [COURSE], TAG)).toBe(TAGGED.replace("ai_agent_course?", "ai_agent_course/pay?"));
  });

  it("без ссылок продукта текст тот же", () => {
    expect(tagProductLinks(`Купить: ${COURSE.url}`, [], TAG)).toBe(`Купить: ${COURSE.url}`);
  });

  it("параметр без значения и кодированные значения сохраняются", () => {
    expect(tagProductLinks(`${COURSE.url}?a=%D0%BA&flag`, [COURSE], TAG)).toBe(
      `${COURSE.url}?a=%D0%BA&flag=&utm_source=vasily&utm_medium=telegram&utm_campaign=ai_agent_course&utm_content=k7m2p9qa`,
    );
  });

  it("повторная разметка ничего не меняет", () => {
    const once = tagProductLinks(COURSE.url, [COURSE], TAG);
    expect(tagProductLinks(once, [COURSE], TAG)).toBe(once);
  });
});
