import { describe, expect, it } from "vitest";
import { connectMax } from "./connect-max";

const bot = { id: "bot-1", title: "ИИ-Куратор", username: "curator_bot" };

describe("connect-max", () => {
  it("подключает Max токеном со стандартного ввода и выводит бота без токена", async () => {
    const calls: unknown[] = [];
    const result = await connectMax({ connectBot: async (input) => (calls.push(input), { ok: true, bot } as never) }, "  secret-token\n");
    expect(calls).toEqual([{ channel: "max", token: "secret-token" }]);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(result).toEqual({ botId: "bot-1", title: "ИИ-Куратор", username: "curator_bot" });
  });

  it("токен из текста ошибки не выходит наружу", async () => {
    const failing = { connectBot: async () => ({ ok: false, error: "Max: неверный токен secret-token" }) as never };
    await expect(connectMax(failing, "secret-token")).rejects.toThrow("Max: неверный токен ***");
  });

  it("пустой ввод — понятная ошибка", async () => {
    await expect(connectMax({ connectBot: async () => ({}) as never }, "  ")).rejects.toThrow("стандартный ввод");
  });
});
