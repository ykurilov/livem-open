// Ошибки журнала агентов: сбой провайдера, после которого запасной путь ответил в том же ходе, — не упавший вызов.
import { describe, expect, it } from "vitest";
import { splitAgentLogErrors, type JournalEntry } from "./agent-log-errors";

const model = (turnId: string, providerId: string, error?: string): JournalEntry => ({
  turnId,
  data: { kind: "model", modelId: "deepseek-4.1-flash", providerId, ...(error && { error }) },
});

describe("splitAgentLogErrors", () => {
  it("сбой провайдера, за которым в том же ходе удачный вызов модели, — закрыт запасным путём", () => {
    const split = splitAgentLogErrors([model("t1", "together", "Credit limit exceeded"), model("t1", "deepseek")]);
    expect(split.errors).toEqual([]);
    expect(split.recovered).toEqual(["модель deepseek-4.1-flash (together → deepseek): Credit limit exceeded"]);
  });

  it("сбой без удачного вызова после него в том же ходе — ошибка", () => {
    const split = splitAgentLogErrors([model("t1", "deepseek"), model("t1", "together", "overloaded"), model("t2", "deepseek")]);
    expect(split.errors).toEqual(["модель deepseek-4.1-flash (together): overloaded"]);
    expect(split.recovered).toEqual([]);
  });

  it("упавший инструмент — всегда ошибка, даже если модель потом ответила", () => {
    const split = splitAgentLogErrors([{ turnId: "t1", data: { kind: "tool", name: "edit_lead_magnet", error: "boom" } }, model("t1", "deepseek")]);
    expect(split.errors).toEqual(["инструмент edit_lead_magnet: boom"]);
  });
});
