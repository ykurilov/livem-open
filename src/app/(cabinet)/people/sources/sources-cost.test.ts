import { describe, expect, it } from "vitest";
import { sourcesCostFormatter } from "./sources-cost";

describe("расход ИИ в таблице источников", () => {
  it("вся колонка с одной точностью: есть суммы меньше доллара — три знака у всех", () => {
    const format = sourcesCostFormatter([0.36, 0, 2.5]);
    expect([0.36, 0, 2.5].map(format)).toEqual(["$0.360", "$0.000", "$2.500"]);
  });

  it("суммы от доллара и нули — два знака", () => {
    const format = sourcesCostFormatter([0, 1.2]);
    expect([0, 1.2].map(format)).toEqual(["$0.00", "$1.20"]);
  });
});
