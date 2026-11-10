import { describe, expect, it } from "vitest";
import type { OutgoingMessage } from "../channels/channel";
import { createFakeClock } from "../platform/clock";
import type { JobName, JobPayloads } from "../platform/queue";
import {
  createWebPushSender,
  isWebPushEndpoint,
  PAGE_OPEN_WINDOW_MS,
  queuedWebChatNotifier,
  webChatNotificationBody,
  type PushVisitor,
  type WebPushSubscription,
} from "./push";

const SUBSCRIPTION: WebPushSubscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } };

function setup(visitor: Partial<PushVisitor> | null) {
  const clock = createFakeClock(new Date("2026-11-05T10:00:00Z"));
  const sent: Array<{ subscription: WebPushSubscription; payload: Record<string, string> }> = [];
  const cleared: Array<{ visitorId: string; endpoint: string }> = [];
  let failure: { statusCode: number } | null = null;
  const sender = createWebPushSender({
    clock,
    findVisitor: async (id) =>
      visitor && { id, pushSubscription: SUBSCRIPTION, lastSeenAt: null, lastCode: "K7mP2xQ", title: "Курс по йоге", ...visitor },
    clearSubscription: async (visitorId, endpoint) => void cleared.push({ visitorId, endpoint }),
    send: async (subscription, payload) => {
      if (failure) throw Object.assign(new Error("push failed"), failure);
      sent.push({ subscription, payload: JSON.parse(payload) });
    },
  });
  // Как задача очереди: текст уведомления собран при отправке сообщения, уходит работником
  const notifier = { notify: (visitorId: string, message: OutgoingMessage) => sender.push(visitorId, webChatNotificationBody(message)) };
  return { clock, sent, cleared, notifier, fail: (statusCode: number) => void (failure = { statusCode }) };
}

describe("уведомления веб-чата", () => {
  it("страница закрыта — уведомление с текстом и ссылкой на чат", async () => {
    const { notifier, sent } = setup({});
    await notifier.notify("visitor-1", { text: "Доброе утро! Как успехи?", idempotencyKey: "k" });
    expect(sent).toEqual([
      { subscription: SUBSCRIPTION, payload: { title: "Курс по йоге", body: "Доброе утро! Как успехи?", url: "/c/K7mP2xQ?from=notification", tag: "web-chat" } },
    ]);
  });

  it("страница открыта (недавно спрашивала новые сообщения) — без уведомления", async () => {
    const { notifier, sent, clock } = setup({ lastSeenAt: new Date("2026-11-05T09:59:50Z") });
    await notifier.notify("visitor-1", { text: "Ответ", idempotencyKey: "k" });
    expect(sent).toEqual([]);
    clock.advance(PAGE_OPEN_WINDOW_MS);
    await notifier.notify("visitor-1", { text: "Ответ", idempotencyKey: "k2" });
    expect(sent).toHaveLength(1);
  });

  it("нет подписки — ничего не шлёт", async () => {
    const { notifier, sent } = setup({ pushSubscription: null });
    await notifier.notify("visitor-1", { text: "Ответ", idempotencyKey: "k" });
    expect(sent).toEqual([]);
  });

  it("длинный текст обрезается, без текста — про картинку", async () => {
    const { notifier, sent } = setup({});
    await notifier.notify("visitor-1", { text: "а".repeat(500), idempotencyKey: "k" });
    await notifier.notify("visitor-1", { text: "", imagePath: "/x.png", idempotencyKey: "k2" });
    expect(sent[0]!.payload.body!.length).toBeLessThanOrEqual(160);
    expect(sent[1]!.payload.body).toBe("Новое сообщение");
  });

  it("подписка отозвана (410) — удаляется та, по которой слали, ошибки наружу нет", async () => {
    const { notifier, cleared, fail } = setup({});
    fail(410);
    await notifier.notify("visitor-1", { text: "Ответ", idempotencyKey: "k" });
    expect(cleared).toEqual([{ visitorId: "visitor-1", endpoint: SUBSCRIPTION.endpoint }]);
  });

  it("временный сбой службы уведомлений (503, обрыв) — ошибка наружу: задача очереди повторит", async () => {
    const { notifier, cleared, fail } = setup({});
    fail(503);
    await expect(notifier.notify("visitor-1", { text: "Ответ", idempotencyKey: "k" })).rejects.toThrow();
    expect(cleared).toEqual([]);
  });

  it("отправка сообщения уведомление не шлёт, а ставит задачей: её сбой и повтор сообщение в ленте не трогают", async () => {
    const enqueued: Array<{ name: JobName; payload: unknown }> = [];
    const notifier = queuedWebChatNotifier({
      enqueue: async <Name extends JobName>(name: Name, payload: JobPayloads[Name]) => void enqueued.push({ name, payload }),
    });
    await notifier.notify("visitor-1", { text: "Доброе   утро!", idempotencyKey: "k" });
    expect(enqueued).toEqual([{ name: "web-chat-push", payload: { visitorId: "visitor-1", body: "Доброе утро!" } }]);
  });

  it("адрес подписки не службы уведомлений браузера — запроса нет, подписка снимается", async () => {
    const { notifier, sent, cleared } = setup({ pushSubscription: { endpoint: "https://127.0.0.1:3142/x", keys: { p256dh: "p", auth: "a" } } });
    await notifier.notify("visitor-1", { text: "Ответ", idempotencyKey: "k" });
    expect(sent).toEqual([]);
    expect(cleared).toEqual([{ visitorId: "visitor-1", endpoint: "https://127.0.0.1:3142/x" }]);
  });
});

describe("адрес службы уведомлений", () => {
  it("пускает службы браузеров, остальное — нет", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QJ3abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ])
      expect(isWebPushEndpoint(endpoint), endpoint).toBe(true);
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://fcm.googleapis.com.evil.test/x",
      "https://evilpush.apple.com.test/x",
      "https://user:pass@fcm.googleapis.com/x",
      "не адрес",
    ])
      expect(isWebPushEndpoint(endpoint), endpoint).toBe(false);
  });
});
