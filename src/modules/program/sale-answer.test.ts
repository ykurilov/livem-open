import { describe, expect, it } from "vitest";
import { nextSaleAnswer } from "./sale-answer";

describe("ответ на продажу", () => {
  it("первое мягкое «нет» — ещё не разобрано", () => {
    expect(nextSaleAnswer(null, { reason: "price", firm: false }, 2)).toEqual({
      reason: "price",
      firm: false,
      softHandled: false,
      lastOfferDay: 2,
    });
  });

  it("повторное мягкое «нет» — разобрано, причина последняя", () => {
    const first = nextSaleAnswer(null, { reason: "price", firm: false }, 2);
    expect(nextSaleAnswer(first, { reason: "time", firm: false }, 2)).toEqual({
      reason: "time",
      firm: false,
      softHandled: true,
      lastOfferDay: 2,
    });
  });

  it("твёрдое «нет» остаётся твёрдым, даже если потом прозвучало мягкое", () => {
    const firm = nextSaleAnswer(null, { reason: "not_interested", firm: true }, 1);
    expect(firm.firm).toBe(true);
    expect(nextSaleAnswer(firm, { reason: "doubt", firm: false }, 3).firm).toBe(true);
  });

  it("день последнего предложения сдвигается", () => {
    const first = nextSaleAnswer(null, { reason: "doubt", firm: false }, 2);
    expect(nextSaleAnswer(first, { reason: "doubt", firm: false }, 3).lastOfferDay).toBe(3);
  });
});
