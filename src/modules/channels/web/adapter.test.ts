import { describe, expect, it } from "vitest";
import type { BotCredentials, OutgoingMessage } from "../channel";
import { createWebChatAdapter } from "./adapter";

const BOT: BotCredentials = { id: "web-bot", token: "", externalId: "web", username: "web", webhookSecret: "" };
const message = (patch: Partial<OutgoingMessage> = {}): OutgoingMessage => ({ text: "Привет", idempotencyKey: "key-1", ...patch });

describe("адаптер веб-чата", () => {
  it("ссылка ведёт на страницу чата с кодом", () => {
    const adapter = createWebChatAdapter({ publicBaseUrl: "https://lm.example.com/" });
    expect(adapter.entryLink({ username: "web", externalId: "web" }, "K7mP2xQ")).toBe("https://lm.example.com/c/K7mP2xQ");
  });

  it("отправка — доставка на страницу: сразу успех и уведомление посетителю", async () => {
    const notified: Array<{ to: string; text: string }> = [];
    const adapter = createWebChatAdapter({ publicBaseUrl: "https://lm.test", notifier: { notify: async (to, sent) => void notified.push({ to, text: sent.text }) } });
    expect(await adapter.send(BOT, "visitor-1", message())).toEqual({ ok: true, externalMessageId: "key-1" });
    expect(notified).toEqual([{ to: "visitor-1", text: "Привет" }]);
  });

  it("сбой уведомления не делает сообщение недоставленным: оно уже на странице", async () => {
    const adapter = createWebChatAdapter({
      publicBaseUrl: "https://lm.test",
      notifier: { notify: async () => Promise.reject(new Error("push недоступен")) },
      logError: () => {},
    });
    expect(await adapter.send(BOT, "visitor-1", message())).toMatchObject({ ok: true });
  });

  it("пустое сообщение не отправляется", async () => {
    const adapter = createWebChatAdapter({ publicBaseUrl: "https://lm.test" });
    expect(await adapter.send(BOT, "visitor-1", message({ text: " " }))).toMatchObject({ ok: false, reason: "empty" });
    expect(await adapter.send(BOT, "visitor-1", message({ text: "", imagePath: "/uploads/a.png" }))).toMatchObject({ ok: true });
  });

  it("бот веб-чата всегда исправен и вебхуков не принимает", async () => {
    const adapter = createWebChatAdapter({ publicBaseUrl: "https://lm.test" });
    expect(await adapter.checkConnection(BOT)).toEqual({ ok: true });
    expect(await adapter.parseWebhook({ headers: {}, body: "{}" }, BOT)).toEqual({ kind: "rejected" });
  });
});
