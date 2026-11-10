import { describe, expect, it } from "vitest";
import { voiceConfigured, voiceRelayConnection } from "./relay-options";

describe("голос на сервере", () => {
  it("ключа Soniox нет или он пустой — голоса нет", () => {
    expect(voiceConfigured({})).toBe(false);
    expect(voiceConfigured({ SONIOX_API_KEY: "  " })).toBe(false);
    expect(voiceConfigured({ SONIOX_API_KEY: "key" })).toBe(true);
  });

  it("без адреса прокси сервер идёт в Soniox напрямую, и пропуск прокси никуда не уходит", () => {
    expect(voiceRelayConnection({ SONIOX_API_KEY: "key", PROXY_TOKEN: "secret" })).toEqual({});
  });

  it("с адресом прокси — туда, с пропуском прокси в заголовке", () => {
    expect(voiceRelayConnection({ SONIOX_WEBSOCKET_URL: "wss://proxy.example/soniox", PROXY_TOKEN: "secret" })).toEqual({
      websocketUrl: "wss://proxy.example/soniox",
      upstreamHeaders: { "X-Proxy-Token": "secret" },
    });
    expect(voiceRelayConnection({ SONIOX_WEBSOCKET_URL: "ws://127.0.0.1:9" })).toEqual({ websocketUrl: "ws://127.0.0.1:9" });
  });
});
