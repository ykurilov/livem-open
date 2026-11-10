import { describe, expect, it } from "vitest";
import { createVoiceSpendingChat, createVoiceUserResolver, webChatVoiceChatId, type VoiceAccessPorts } from "./access";

const VOICE_URL = "https://livem.example/api/voice/stream";

function ports(overrides: Partial<VoiceAccessPorts> = {}): VoiceAccessPorts {
  return {
    webChatVisitorId: async () => "visitor-1",
    webChatVoiceEnabled: async () => true,
    webChatPayer: async () => ({ ownerId: "person-1", chatId: "passage-chat-1" }),
    cabinetUser: async () => ({ id: "cabinet" }),
    previewVoiceEnabled: async () => true,
    ...overrides,
  };
}

const request = (chat: string | null) => new Request(chat === null ? VOICE_URL : `${VOICE_URL}?chat=${encodeURIComponent(chat)}`);

describe("кто может диктовать", () => {
  it("посетитель веб-чата диктует, если у опубликованного лидмагнита ссылки включён голосовой ввод", async () => {
    const asked: string[] = [];
    const resolve = createVoiceUserResolver(ports({ webChatVoiceEnabled: async (code) => (asked.push(code), true) }));
    expect(await resolve(request(webChatVoiceChatId("abc_1")))).toEqual({ id: "person-1" });
    expect(asked).toEqual(["abc_1"]);
  });

  it("разговор ещё не начался (нет человека) — диктует посетитель, расход ложится на метку посетителя", async () => {
    const resolve = createVoiceUserResolver(ports({ webChatPayer: async () => null }));
    expect(await resolve(request(webChatVoiceChatId("abc")))).toEqual({ id: "web-visitor:visitor-1" });
  });

  it("веб-чат без cookie посетителя — не вошёл; кабинет за посетителя не считается", async () => {
    const resolve = createVoiceUserResolver(ports({ webChatVisitorId: async () => null }));
    expect(await resolve(request(webChatVoiceChatId("abc")))).toBeNull();
  });

  it("голосовой ввод у лидмагнита выключен — отказ, Soniox не зовётся", async () => {
    const resolve = createVoiceUserResolver(ports({ webChatVoiceEnabled: async () => false }));
    expect(await resolve(request(webChatVoiceChatId("abc")))).toEqual({ refused: expect.objectContaining({ code: "voice_off" }) });
  });

  it("«Проверка»: вошедший в кабинет диктует, если у черновика лидмагнита этого тестового чата голос включён", async () => {
    const asked: string[] = [];
    const resolve = createVoiceUserResolver(ports({ previewVoiceEnabled: async (chatId) => (asked.push(chatId), true) }));
    expect(await resolve(request("preview-chat-1"))).toEqual({ id: "cabinet" });
    expect(asked).toEqual(["preview-chat-1"]);
  });

  it("«Проверка» без входа в кабинет — не вошёл; посетитель веб-чата сюда не проходит", async () => {
    const resolve = createVoiceUserResolver(ports({ cabinetUser: async () => null }));
    expect(await resolve(request("preview-chat-1"))).toBeNull();
  });

  it("«Проверка» с выключенным голосом или чужим чатом — отказ", async () => {
    const resolve = createVoiceUserResolver(ports({ previewVoiceEnabled: async () => false }));
    expect(await resolve(request("not-a-preview"))).toEqual({ refused: expect.objectContaining({ code: "voice_off" }) });
  });

  it("адрес без чата или с пустым кодом — не наш случай: отказ без обращения к базе", async () => {
    const touched: string[] = [];
    const resolve = createVoiceUserResolver(
      ports({
        webChatVisitorId: async () => (touched.push("visitor"), "v"),
        cabinetUser: async () => (touched.push("cabinet"), { id: "cabinet" }),
      }),
    );
    expect(await resolve(request(null))).toEqual({ refused: expect.objectContaining({ code: "voice_off" }) });
    expect(await resolve(request(webChatVoiceChatId("")))).toEqual({ refused: expect.objectContaining({ code: "voice_off" }) });
    expect(touched).toEqual([]);
  });
});

describe("на какой чат ложится расход диктовки", () => {
  it("веб-чат: на чат прохождения человека по этому лидмагниту — как переписка с консультантом", async () => {
    const asked: [string, string][] = [];
    const chatOf = createVoiceSpendingChat(ports({ webChatPayer: async (visitorId, code) => (asked.push([visitorId, code]), { ownerId: "person-1", chatId: "passage-chat-1" }) }));
    expect(await chatOf(request(webChatVoiceChatId("abc")), { id: "person-1" })).toBe("passage-chat-1");
    expect(asked).toEqual([["visitor-1", "abc"]]);
  });

  it("веб-чат без прохождения — общая метка голоса", async () => {
    const chatOf = createVoiceSpendingChat(ports({ webChatPayer: async () => null }));
    expect(await chatOf(request(webChatVoiceChatId("abc")), { id: "web-visitor:visitor-1" })).toBe("voice");
  });

  it("«Проверка»: на её тестовый чат", async () => {
    const chatOf = createVoiceSpendingChat(ports());
    expect(await chatOf(request("preview-chat-1"), { id: "cabinet" })).toBe("preview-chat-1");
  });
});
