import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "./pool";

describe("runWithConcurrency", () => {
  it("одновременно идёт не больше заданного числа задач, результаты по порядку входа", async () => {
    let running = 0;
    let peak = 0;
    const results = await runWithConcurrency([30, 5, 20, 10, 1, 15], 3, async (ms) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return ms * 2;
    });
    expect(peak).toBe(3);
    expect(results.map((result) => (result.status === "fulfilled" ? result.value : null))).toEqual([60, 10, 40, 20, 2, 30]);
  });

  it("падение одной задачи не останавливает остальные", async () => {
    const results = await runWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error("упало");
      return value;
    });
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("предел меньше 1 — ошибка", async () => {
    await expect(runWithConcurrency([1], 0, async (value) => value)).rejects.toThrow();
  });
});
