import { describe, expect, it } from "vitest";
import { findSalesCliches, SALES_CLICHES } from "./sales-cliches";

describe("штампы продаж", () => {
  it("находит заученные фразы из тренингов", () => {
    expect(findSalesCliches("Дорого — по сравнению с чем?")).toEqual(["по сравнению с чем"]);
    expect(findSalesCliches("А что вас останавливает?")).toEqual(["что вас останавливает"]);
    expect(findSalesCliches("Что ВАС ОСТАНАВЛИВАЕТ от решения")).toEqual(["что вас останавливает"]);
  });

  it("находит фальшивую срочность и нажим", () => {
    expect(findSalesCliches("Только сегодня цена ниже!")).toContain("только сегодня");
    expect(findSalesCliches("Осталось всего 3 места")).toContain("осталось N мест");
    expect(findSalesCliches("Не упустите свой шанс")).toContain("не упустите шанс");
    expect(findSalesCliches("Это инвестиция в себя")).toContain("инвестиция в себя");
  });

  it("ё и е не различаются", () => {
    expect(findSalesCliches("Учтите: предложение ограничено.")).toContain("предложение ограничено");
  });

  it("живой вопрос без штампа — чисто", () => {
    expect(findSalesCliches("Вы вчера сами собрали первую страницу. Что из этого хочется довести до конца?")).toEqual([]);
    expect(findSalesCliches("Сколько времени в неделю вы готовы на это тратить?")).toEqual([]);
  });

  it("у каждого штампа есть название — его покажут проверки eval", () => {
    for (const cliche of SALES_CLICHES) expect(cliche.phrase.trim()).not.toBe("");
  });
});
