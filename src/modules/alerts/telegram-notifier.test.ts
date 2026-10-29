import { describe, expect, it } from "vitest";
import { createTelegramNotifier } from "./telegram-notifier";

describe("отправитель тревог в Telegram", () => {
  it("шлёт sendMessage по адресу из настроек", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const notifier = createTelegramNotifier({
      token: "9:tok",
      apiBaseUrl: "https://proxy.test/tg/",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), body: JSON.parse(String(init?.body)) });
        return new Response("{}", { status: 200 });
      },
    });
    await notifier.send("42", "Тревога");
    expect(calls).toEqual([{ url: "https://proxy.test/tg/bot9:tok/sendMessage", body: { chat_id: "42", text: "Тревога" } }]);
  });

  it("с пропуском прокси шлёт X-Proxy-Token", async () => {
    let proxyToken: string | null = null;
    const notifier = createTelegramNotifier({
      token: "9:tok",
      apiBaseUrl: "https://proxy.test/tg",
      proxyToken: "pass-1",
      fetch: async (_input, init) => {
        proxyToken = new Headers(init?.headers).get("x-proxy-token");
        return new Response("{}", { status: 200 });
      },
    });
    await notifier.send("42", "Тревога");
    expect(proxyToken).toBe("pass-1");
  });

  it("зависший Telegram не вешает проверку навсегда: по таймауту — понятная ошибка", async () => {
    const notifier = createTelegramNotifier({
      token: "9:tok",
      requestTimeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    await expect(notifier.send("42", "Тревога")).rejects.toThrow("Telegram не ответил");
  });

  it("запрос уходит с ограничением по времени по умолчанию", async () => {
    let signal: AbortSignal | null | undefined;
    const notifier = createTelegramNotifier({
      token: "9:tok",
      fetch: async (_input, init) => {
        signal = init?.signal;
        return new Response("{}", { status: 200 });
      },
    });
    await notifier.send("42", "Тревога");
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("отказ Telegram — ошибка с его пояснением", async () => {
    const notifier = createTelegramNotifier({
      token: "9:tok",
      fetch: async () => new Response(JSON.stringify({ description: "chat not found" }), { status: 400 }),
    });
    await expect(notifier.send("42", "x")).rejects.toThrow("chat not found");
  });
});
