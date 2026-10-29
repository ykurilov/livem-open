import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotifierFromEnv } from "./from-env";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("отправитель тревог из окружения", () => {
  it("без ALERT_BOT_TOKEN отправка падает с понятной причиной", async () => {
    await expect(createNotifierFromEnv({}).send("1", "текст")).rejects.toThrow("ALERT_BOT_TOKEN");
  });

  it("STUB_CHANNEL=fake — тревоги пишутся в журнал сервера, без Telegram", async () => {
    const logged: unknown[] = [];
    const log = vi.spyOn(console, "warn").mockImplementation((...args) => void logged.push(args.join(" ")));
    vi.stubGlobal("fetch", async () => {
      throw new Error("Сеть в проверках не нужна");
    });
    await createNotifierFromEnv({ STUB_CHANNEL: "fake", ALERT_BOT_TOKEN: "9:tok" }).send("-100", "Бюджет 100%");
    expect(logged).toEqual([expect.stringContaining("Бюджет 100%")]);
    log.mockRestore();
  });

  it("STUB_CHANNEL в продакшене запрещена", () => {
    expect(() => createNotifierFromEnv({ STUB_CHANNEL: "fake", NODE_ENV: "production" })).toThrow("STUB_CHANNEL");
  });

  it("с токеном шлёт через TELEGRAM_API_BASE_URL", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      calls.push(input.toString());
      return new Response("{}", { status: 200 });
    });
    await createNotifierFromEnv({ ALERT_BOT_TOKEN: "9:tok", TELEGRAM_API_BASE_URL: "https://proxy.test/tg" }).send("1", "текст");
    expect(calls).toEqual(["https://proxy.test/tg/bot9:tok/sendMessage"]);
  });

  it("через прокси шлёт пропуск X-Proxy-Token из PROXY_TOKEN", async () => {
    const tokens: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get("x-proxy-token"));
      return new Response("{}", { status: 200 });
    });
    await createNotifierFromEnv({
      ALERT_BOT_TOKEN: "9:tok",
      TELEGRAM_API_BASE_URL: "https://proxy.test/tg",
      PROXY_TOKEN: "pass-1",
    }).send("1", "текст");
    expect(tokens).toEqual(["pass-1"]);
  });
});
