import { describe, expect, it } from "vitest";
import { createRedactor } from "./redact";

describe("секреты в журнале", () => {
  const redact = createRedactor({
    PROXY_TOKEN: "proxy-secret-value-123",
    TOGETHER_API_KEY: "tg-key-abcdef",
    DATABASE_URL: "postgres://u:p@h/db",
    NODE_ENV: "production",
  });

  it("значения секретов из окружения вычищаются из любого места", () => {
    expect(redact({ text: "токен proxy-secret-value-123 и tg-key-abcdef" })).toEqual({ text: "токен [скрыто] и [скрыто]" });
    expect(redact(["postgres://u:p@h/db"])).toEqual(["[скрыто]"]);
  });

  it("поля с секретными именами скрыты целиком, обычные — нет", () => {
    expect(
      redact({ botToken: "123", apiKey: "k", "X-Proxy-Token": "t", password: "p", authorization: "Bearer x", inputTokens: 5, name: "Ок" }),
    ).toEqual({ botToken: "[скрыто]", apiKey: "[скрыто]", "X-Proxy-Token": "[скрыто]", password: "[скрыто]", authorization: "[скрыто]", inputTokens: 5, name: "Ок" });
  });

  it("токены по виду: бот Telegram, Bearer, sk-", () => {
    expect(redact("бот 1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0 готов")).toBe("бот [скрыто] готов");
    expect(redact("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [скрыто]");
    expect(redact("ключ sk-proj-ABCDEFGHIJKLMNOPQRSTUV")).toBe("ключ [скрыто]");
  });

  it("длинные строки обрезаются", () => {
    const long = "а".repeat(30_000);
    const result = redact(long) as string;
    expect(result.length).toBeLessThan(21_000);
    expect(result).toContain("обрезано");
  });
});
