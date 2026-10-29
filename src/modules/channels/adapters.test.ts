import { describe, expect, it } from "vitest";
import { createChannelAdapters } from "./adapters";
import { FakeChannel } from "./fake";

function recordingFetch(calls: string[]): typeof fetch {
  return async (input) => {
    calls.push(input.toString());
    return new Response(JSON.stringify({ ok: true, result: { id: 1, first_name: "B", username: "b_bot" } }));
  };
}

describe("адаптеры мессенджеров из окружения", () => {
  it("Telegram ходит по адресу из TELEGRAM_API_BASE_URL", async () => {
    const calls: string[] = [];
    const adapters = createChannelAdapters({ TELEGRAM_API_BASE_URL: "https://proxy.test/tg" }, { fetch: recordingFetch(calls) });
    await adapters.telegram?.verifyToken("1:abc");
    expect(calls).toEqual(["https://proxy.test/tg/bot1:abc/getMe"]);
  });

  it("через прокси Telegram шлёт пропуск X-Proxy-Token из PROXY_TOKEN", async () => {
    const tokens: Array<string | null> = [];
    const adapters = createChannelAdapters(
      { TELEGRAM_API_BASE_URL: "https://proxy.test/tg", PROXY_TOKEN: "pass-1" },
      {
        fetch: async (_input, init) => {
          tokens.push(new Headers(init?.headers).get("x-proxy-token"));
          return new Response(JSON.stringify({ ok: true, result: { id: 1, first_name: "B", username: "b_bot" } }));
        },
      },
    );
    await adapters.telegram?.verifyToken("1:abc");
    expect(tokens).toEqual(["pass-1"]);
  });

  it("напрямую к api.telegram.org пропуск прокси не уходит", async () => {
    const tokens: Array<string | null> = [];
    await createChannelAdapters(
      { PROXY_TOKEN: "pass-1" },
      {
        fetch: async (_input, init) => {
          tokens.push(new Headers(init?.headers).get("x-proxy-token"));
          return new Response(JSON.stringify({ ok: true, result: { id: 1, first_name: "B", username: "b_bot" } }));
        },
      },
    ).telegram?.verifyToken("1:abc");
    expect(tokens).toEqual([null]);
  });

  it("без переменной (или пустой) — api.telegram.org", async () => {
    const calls: string[] = [];
    await createChannelAdapters({ TELEGRAM_API_BASE_URL: "" }, { fetch: recordingFetch(calls) }).telegram?.verifyToken("1:abc");
    expect(calls).toEqual(["https://api.telegram.org/bot1:abc/getMe"]);
  });

  it("ВК и Max подключены: ходят на api.vk.com и platform-api.max.ru", async () => {
    const calls: string[] = [];
    const answer = { response: { groups: [{ id: 1, name: "G", screen_name: "g" }] }, user_id: 2, first_name: "B", username: "b_bot" };
    const adapters = createChannelAdapters({}, {
      fetch: async (input) => {
        calls.push(input.toString());
        return new Response(JSON.stringify(answer));
      },
    });
    expect(adapters.vk?.kind).toBe("vk");
    expect(adapters.max?.kind).toBe("max");
    await adapters.vk?.verifyToken("vk1.a.x");
    await adapters.max?.verifyToken("max-token");
    expect(calls).toEqual(["https://api.vk.com/method/groups.getById", "https://api.vk.com/method/groups.getTokenPermissions", "https://platform-api.max.ru/me"]);
  });

  it("STUB_CHANNEL=fake — подделка вместо Telegram, в продакшене — отказ", () => {
    expect(createChannelAdapters({ STUB_CHANNEL: "fake" }).telegram).toBeInstanceOf(FakeChannel);
    expect(() => createChannelAdapters({ STUB_CHANNEL: "fake", NODE_ENV: "production" })).toThrow(/STUB_CHANNEL/);
  });
});
