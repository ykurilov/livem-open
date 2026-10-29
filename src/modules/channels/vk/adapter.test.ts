import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotCredentials, ChannelEvent, WebhookRequest } from "../channel";
import { createVkAdapter, VK_API_VERSION } from "./adapter";
import { FakeVkApi, UPLOAD_URL, vkError } from "./fake-vk-api";
import * as events from "./recorded-events";

const API_BASE = "https://vk-api.test";
const WEBHOOK_URL = "https://livem.test/api/webhooks/vk/bot-1";
const bot: BotCredentials = {
  id: "bot-1",
  token: "vk1.a.secret-community-token",
  externalId: "222333",
  username: "live_magnet_club",
  // «_» и «-» ВК в ключе не нужны: адаптер подменяет их на букву (см. recorded-events)
  webhookSecret: "hook_secret-1",
};

let api: FakeVkApi;
let adapter: ReturnType<typeof createVkAdapter>;

beforeEach(() => {
  api = new FakeVkApi();
  adapter = createVkAdapter({ apiBaseUrl: API_BASE, fetch: api.fetch });
});

function webhook(body: unknown): WebhookRequest {
  return { headers: {}, body: JSON.stringify(body) };
}

async function eventsOf(body: unknown): Promise<ChannelEvent[]> {
  const parsed = await adapter.parseWebhook(webhook(body), bot);
  if (parsed.kind !== "events") throw new Error(`Ожидались события, получено ${parsed.kind}`);
  return parsed.events;
}

describe("подключение сообщества", () => {
  it("verifyToken: groups.getById и права ключа (groups.getTokenPermissions) с ключом и версией API, id, адрес и название сообщества", async () => {
    const identity = await adapter.verifyToken(bot.token);
    expect(identity).toEqual({ externalId: "222333", username: "live_magnet_club", title: "Живые лидмагниты" });
    expect(api.requests).toEqual([
      { method: "groups.getById", params: { access_token: bot.token, v: VK_API_VERSION } },
      { method: "groups.getTokenPermissions", params: { access_token: bot.token, v: VK_API_VERSION } },
    ]);
  });

  it("verifyToken: версия API — 5.199", () => {
    expect(VK_API_VERSION).toBe("5.199");
  });

  it("verifyToken: понимает и старую форму ответа (массив сообществ)", async () => {
    api.replyOnce("groups.getById", { status: 200, body: { response: [{ id: 5, name: "Старое", screen_name: "old_club" }] } });
    expect(await adapter.verifyToken(bot.token)).toEqual({ externalId: "5", username: "old_club", title: "Старое" });
  });

  it("verifyToken: ошибка 5 — «неверный ключ», самого ключа в тексте нет", async () => {
    api.replyOnce("groups.getById", vkError(5, `User authorization failed: invalid access_token (4). ${bot.token}`));
    const error = await adapter.verifyToken(bot.token).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Неверный ключ доступа сообщества");
    expect((error as Error).message).not.toContain(bot.token);
  });

  it("verifyToken: личный токен вместо ключа сообщества (ошибка 100) — понятное пояснение", async () => {
    api.replyOnce("groups.getById", vkError(100, "One of the parameters specified was missing or invalid: group_id is undefined"));
    await expect(adapter.verifyToken(bot.token)).rejects.toThrow("ключ сообщества");
  });

  it("verifyToken: у ключа не хватает прав — называет каждое недостающее право", async () => {
    api.replyOnce("groups.getTokenPermissions", { status: 200, body: { response: { mask: 4096, permissions: [{ name: "messages", setting: 4096 }] } } });
    const error = await adapter.verifyToken(bot.token).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("У ключа нет права «Управление сообществом»");
    expect((error as Error).message).toContain("«Фотографии»");
    expect((error as Error).message).not.toContain("нет права «Сообщения сообщества»");
  });

  it("verifyToken: все права есть — подключаем; ВК не ответил про права — не мешаем, решит connect", async () => {
    await expect(adapter.verifyToken(bot.token)).resolves.toMatchObject({ externalId: "222333" });
    api.replyOnce("groups.getTokenPermissions", vkError(10, "Internal server error"));
    await expect(adapter.verifyToken(bot.token)).resolves.toMatchObject({ externalId: "222333" });
  });

  it("verifyToken: у сообщества нет короткого адреса — username пустой, ссылка строится по id", async () => {
    api.replyOnce("groups.getById", { status: 200, body: { response: { groups: [{ id: 222333, name: "Без адреса" }] } } });
    expect((await adapter.verifyToken(bot.token)).username).toBe("");
  });

  it("connect: добавляет сервер с адресом и секретом, включает нужные события версии 5.199", async () => {
    await adapter.connect(bot, WEBHOOK_URL);
    const [add] = api.callsTo("groups.addCallbackServer");
    expect(add?.params).toMatchObject({ group_id: "222333", url: WEBHOOK_URL, secret_key: events.SECRET, access_token: bot.token });
    expect(add?.params.title).toBeTruthy();

    const [settings] = api.callsTo("groups.setCallbackSettings");
    expect(settings?.params).toMatchObject({
      group_id: "222333",
      server_id: "77",
      api_version: "5.199",
      message_new: "1",
      message_allow: "1",
      message_deny: "1",
      message_event: "1",
    });
    // Лишние события не нужны: каждое — лишний запрос на вебхук
    const enabled = Object.entries(settings?.params ?? {}).filter(([name, value]) => name !== "group_id" && value === "1");
    expect(enabled.map(([name]) => name).sort()).toEqual(["message_allow", "message_deny", "message_event", "message_new"]);
  });

  it("connect: секрет — только латинские буквы и цифры, не длиннее 50 знаков", async () => {
    await adapter.connect({ ...bot, webhookSecret: "Zq_9-ab".repeat(6) }, WEBHOOK_URL);
    const secret = api.callsTo("groups.addCallbackServer")[0]?.params.secret_key ?? "";
    expect(secret).toMatch(/^[A-Za-z0-9]{1,50}$/);
  });

  it("connect: старый сервер с тем же адресом убирается, чужие серверы остаются", async () => {
    api.replyOnce("groups.getCallbackServers", {
      status: 200,
      body: {
        response: {
          count: 2,
          items: [
            { id: 11, title: "Старый", url: WEBHOOK_URL, secret_key: "old", status: "ok" },
            { id: 12, title: "Чужой", url: "https://other.test/hook", secret_key: "", status: "ok" },
          ],
        },
      },
    });
    await adapter.connect(bot, WEBHOOK_URL);
    expect(api.callsTo("groups.deleteCallbackServer").map((call) => call.params)).toEqual([
      expect.objectContaining({ group_id: "222333", server_id: "11" }),
    ]);
  });

  it("connect: ВК не получил код подтверждения — ошибка с пояснением ВК", async () => {
    api.replyOnce("groups.addCallbackServer", vkError(1, "Unknown error occurred: server did not return confirmation code"));
    await expect(adapter.connect(bot, WEBHOOK_URL)).rejects.toThrow("confirmation code");
    expect(api.callsTo("groups.setCallbackSettings")).toHaveLength(0);
  });

  it("connect: нет доступа к настройке сервера (ошибка 15) — «у ключа нет права „Управление сообществом“»", async () => {
    api.replyOnce("groups.setCallbackSettings", vkError(15, "Access denied: no access to call this method"));
    await expect(adapter.connect(bot, WEBHOOK_URL)).rejects.toThrow("У ключа нет права «Управление сообществом»");
    api.replyOnce("groups.getCallbackServers", vkError(15, "Access denied: no access to call this method"));
    await expect(adapter.connect(bot, WEBHOOK_URL)).rejects.toThrow("У ключа нет права «Управление сообществом»");
  });

  it("disconnect: удаляет серверы с адресом этого бота, чужие не трогает", async () => {
    api.replyOnce("groups.getCallbackServers", {
      status: 200,
      body: {
        response: {
          count: 3,
          items: [
            { id: 21, title: "Наш", url: "https://livem.test/api/webhooks/vk/bot-1", secret_key: "x", status: "ok" },
            { id: 22, title: "Наш бот-2", url: "https://livem.test/api/webhooks/vk/bot-2", secret_key: "x", status: "ok" },
            { id: 23, title: "Чужой", url: "https://other.test/hook", secret_key: "", status: "ok" },
          ],
        },
      },
    });
    await adapter.disconnect(bot, WEBHOOK_URL);
    expect(api.callsTo("groups.deleteCallbackServer").map((call) => call.params.server_id)).toEqual(["21"]);
  });

  it("disconnect: адрес сравнивается целиком — чужой сервер с таким же хвостом не удаляется", async () => {
    api.replyOnce("groups.getCallbackServers", {
      status: 200,
      body: {
        response: {
          count: 3,
          items: [
            { id: 31, title: "Чужой хост", url: "https://other.test/api/webhooks/vk/bot-1", secret_key: "", status: "ok" },
            { id: 32, title: "Другой префикс", url: "https://livem.test/old/api/webhooks/vk/bot-1", secret_key: "", status: "ok" },
            { id: 33, title: "Наш", url: WEBHOOK_URL, secret_key: "x", status: "ok" },
          ],
        },
      },
    });
    await adapter.disconnect(bot, WEBHOOK_URL);
    expect(api.callsTo("groups.deleteCallbackServer").map((call) => call.params.server_id)).toEqual(["33"]);
  });

  it("checkConnection: groups.getById отвечает — всё хорошо", async () => {
    expect(await adapter.checkConnection(bot)).toEqual({ ok: true });
  });

  it.each([
    [5, "User authorization failed: invalid access_token"],
    [27, "Group authorization failed: method is unavailable with group auth"],
    [28, "Application authorization failed: token has expired"],
  ])("checkConnection: ошибка %i — ключ не действует (invalid_token)", async (code, message) => {
    api.replyOnce("groups.getById", vkError(code, message));
    expect(await adapter.checkConnection(bot)).toEqual({ ok: false, kind: "invalid_token", error: message });
  });

  it.each([
    ["ошибка 6, слишком часто", vkError(6, "Too many requests per second"), "Too many requests"],
    ["ошибка 10, сбой ВК", vkError(10, "Internal server error"), "Internal server error"],
    ["прокси отдал 502 не от ВК", { status: 502, body: "<html>Bad Gateway</html>" }, "502"],
    ["сеть упала", new Error("connect ECONNREFUSED"), "ECONNREFUSED"],
  ])("checkConnection: %s — временный сбой (temporary)", async (_name, reply, text) => {
    api.replyOnce("groups.getById", reply);
    const result = await adapter.checkConnection(bot);
    expect(result).toMatchObject({ ok: false, kind: "temporary" });
    expect(JSON.stringify(result)).toContain(text);
  });

  it("checkConnection: ключа в тексте сбоя нет", async () => {
    api.replyOnce("groups.getById", new Error(`fetch failed: access_token=${bot.token}`));
    expect(JSON.stringify(await adapter.checkConnection(bot))).not.toContain(bot.token);
  });

  it("checkConnection: зависший запрос (таймаут) — временный сбой, а не исключение", async () => {
    const hanging = createVkAdapter({
      requestTimeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    expect(await hanging.checkConnection(bot)).toMatchObject({ ok: false, kind: "temporary" });
  });

  it("по умолчанию ходит на api.vk.com", async () => {
    const calls: string[] = [];
    const direct = createVkAdapter({
      fetch: async (input) => {
        calls.push(input.toString());
        return new Response(JSON.stringify({ response: { groups: [{ id: 1, name: "G", screen_name: "g" }] } }));
      },
    });
    await direct.verifyToken("vk1.a.x");
    expect(calls[0]).toBe("https://api.vk.com/method/groups.getById");
    expect(calls.every((url) => url.startsWith("https://api.vk.com/method/"))).toBe(true);
  });
});

describe("разбор вебхука: подтверждение и секрет", () => {
  it("confirmation: ответ — код подтверждения из groups.getCallbackConfirmationCode", async () => {
    expect(await adapter.parseWebhook(webhook(events.confirmation), bot)).toEqual({ kind: "handshake", responseBody: "a1b2c3d4" });
    expect(api.callsTo("groups.getCallbackConfirmationCode")[0]?.params).toMatchObject({
      group_id: "222333",
      access_token: bot.token,
      v: VK_API_VERSION,
    });
  });

  it("confirmation без поля secret — rejected, к ВК не обращаемся (секрет мы задаём сами при addCallbackServer)", async () => {
    expect(await adapter.parseWebhook(webhook(events.confirmationWithoutSecret), bot)).toEqual({ kind: "rejected" });
    expect(api.requests).toEqual([]);
  });

  it("confirmation для другого сообщества — rejected", async () => {
    expect(await adapter.parseWebhook(webhook(events.confirmationForAnotherGroup), bot)).toEqual({ kind: "rejected" });
    expect(api.requests).toEqual([]);
  });

  it("не удалось получить код подтверждения — понятный отказ (rejected), а не исключение", async () => {
    api.replyOnce("groups.getCallbackConfirmationCode", vkError(15, `Access denied ${bot.token}`));
    expect(await adapter.parseWebhook(webhook(events.confirmation), bot)).toEqual({ kind: "rejected" });
  });

  it("ВК не ответил на запрос кода подтверждения (сеть) — тоже rejected", async () => {
    api.replyOnce("groups.getCallbackConfirmationCode", new Error("connect ECONNREFUSED"));
    expect(await adapter.parseWebhook(webhook(events.confirmation), bot)).toEqual({ kind: "rejected" });
  });

  it("событие с неверным секретом — rejected", async () => {
    expect(await adapter.parseWebhook(webhook({ ...events.plainText, secret: "чужой" }), bot)).toEqual({ kind: "rejected" });
  });

  it("событие без секрета — rejected", async () => {
    const { secret: _secret, ...withoutSecret } = events.plainText;
    expect(await adapter.parseWebhook(webhook(withoutSecret), bot)).toEqual({ kind: "rejected" });
  });

  it("секрет другой длины — rejected, а не ошибка", async () => {
    expect(await adapter.parseWebhook(webhook({ ...events.plainText, secret: "x" }), bot)).toEqual({ kind: "rejected" });
  });

  it("событие другого сообщества — rejected", async () => {
    expect(await adapter.parseWebhook(webhook({ ...events.plainText, group_id: 999 }), bot)).toEqual({ kind: "rejected" });
  });

  it("тело не JSON — rejected", async () => {
    expect(await adapter.parseWebhook({ headers: {}, body: "<html>" }, bot)).toEqual({ kind: "rejected" });
  });

  it("тело — не объект — rejected", async () => {
    expect(await adapter.parseWebhook(webhook([1, 2]), bot)).toEqual({ kind: "rejected" });
  });

  it("ответ на любое событие — строго «ok»", async () => {
    for (const event of [events.plainText, events.messagesDenied, events.wallPostNew, events.groupChatMessage]) {
      expect(await adapter.parseWebhook(webhook(event), bot)).toMatchObject({ kind: "events", responseBody: "ok" });
    }
  });
});

describe("разбор вебхука: сообщения", () => {
  it("обычный текст: ключ повтора из event_id, человек — from_id; имени ВК не присылает", async () => {
    expect(await eventsOf(events.plainText)).toEqual([
      {
        type: "message",
        dedupeKey: "vk:bot-1:9f2c0a77aa41d3b6c1f0d5e8a2b3c4d5e6f70809",
        userId: "5550001",
        text: "Хочу научиться делать рассылки",
      },
    ]);
  });

  it("ссылка с кодом: message.ref — startCode", async () => {
    const [event] = await eventsOf(events.startWithRef);
    expect(event).toMatchObject({ type: "message", text: "Начать", startCode: "Ab3dE5gH" });
  });

  it("пришёл только ref_source — код берётся из него", async () => {
    const [event] = await eventsOf(events.startWithRefSourceOnly);
    expect(event).toMatchObject({ startCode: "Zz9Yy8Xx" });
  });

  it("кнопка «Начать» без кода — текст «/start», startCode нет (как голый /start в Telegram)", async () => {
    const [event] = await eventsOf(events.startWithoutRef);
    expect(event).toMatchObject({ type: "message", text: "/start" });
    expect(event).not.toHaveProperty("startCode");
  });

  it("обычный текст — без startCode и вложения", async () => {
    const [event] = await eventsOf(events.plainText);
    expect(event).not.toHaveProperty("startCode");
    expect(event).not.toHaveProperty("attachment");
  });

  it("ссылка со сниппетом ВК (вложение link) — просто текст: сниппет не вложение человека", async () => {
    const [event] = await eventsOf(events.linkWithSnippet);
    expect(event).toMatchObject({ type: "message", text: "https://koleso-uzhina.apps.example.com/" });
    expect(event).not.toHaveProperty("attachment");
  });

  it.each([
    ["фото", events.photoWithCaption, "image", "Вот мой текущий сайт"],
    ["голосовое", events.voiceMessage, "voice", ""],
    ["стикер", events.stickerMessage, "sticker", ""],
    ["документ", events.documentMessage, "file", "Бриф"],
    ["запись на стене", events.wallPostMessage, "other", ""],
    ["геопозиция", events.locationMessage, "other", ""],
  ] as const)("вложение: %s", async (_name, event, attachment, text) => {
    expect(await eventsOf(event)).toEqual([expect.objectContaining({ type: "message", attachment, text })]);
  });

  it("message_event: нажатие кнопки — button; callbackId хватает для sendMessageEventAnswer, данные кнопки — наши", async () => {
    expect(await eventsOf(events.buttonPressed)).toEqual([
      {
        type: "button",
        dedupeKey: "vk:bot-1:ad0d0d0dbe1e1e1ecf2f2f2f0a3a3a3a1b4b4b4b",
        userId: "5550001",
        callbackId: "5550001|5550001|ev-5550001-1790000010",
        payload: "menu:lead-magnet-1",
      },
    ]);
  });

  it("message_event: данные кнопки строкой с JSON — те же данные", async () => {
    expect(await eventsOf(events.buttonPressedStringPayload)).toEqual([
      expect.objectContaining({ type: "button", payload: "menu:lead-magnet-1" }),
    ]);
  });

  it("message_event: чужие данные кнопки остаются как есть (JSON-строкой)", async () => {
    expect(await eventsOf(events.buttonWithForeignPayload)).toEqual([
      expect.objectContaining({ type: "button", payload: '{"cmd":"x"}' }),
    ]);
  });

  it("message_deny: человек запретил сообщения — blocked", async () => {
    expect(await eventsOf(events.messagesDenied)).toEqual([
      { type: "blocked", dedupeKey: "vk:bot-1:0a3a3a3a1b4b4b4b2c5c5c5c3d6d6d6d4e7e7e7e", userId: "5550001" },
    ]);
  });

  it("message_allow: человек разрешил сообщения — unblocked", async () => {
    expect(await eventsOf(events.messagesAllowed)).toEqual([
      { type: "unblocked", dedupeKey: "vk:bot-1:1b4b4b4b2c5c5c5c3d6d6d6d4e7e7e7e5f8f8f8f", userId: "5550001" },
    ]);
  });

  describe("запрет и разрешение сообщений без event_id", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const { event_id: _eventId, ...denyWithoutEventId } = events.messagesDenied;
    const { event_id: _allowEventId, ...allowWithoutEventId } = events.messagesAllowed;
    const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });

    it("запрет → разрешение → снова запрет: второй запрет не теряется (ключи разные)", async () => {
      at("2026-10-03T10:00:00Z");
      const [firstDeny] = await eventsOf(denyWithoutEventId);
      at("2026-10-03T10:05:00Z");
      const [allow] = await eventsOf(allowWithoutEventId);
      at("2026-10-03T10:10:00Z");
      const [secondDeny] = await eventsOf(denyWithoutEventId);
      const keys = [firstDeny, allow, secondDeny].map((event) => event?.dedupeKey);
      expect(new Set(keys).size).toBe(3);
    });

    it("в запросе есть время события (object.date) — ключ берётся из него и стабилен при повторе", async () => {
      const withDate = { ...denyWithoutEventId, object: { user_id: 5550001, date: 1790000100 } };
      at("2026-10-03T10:00:00Z");
      const [first] = await eventsOf(withDate);
      at("2026-10-03T11:00:00Z");
      const [repeat] = await eventsOf(withDate);
      expect(repeat).toEqual(first);
      expect(first?.dedupeKey).toContain("1790000100");
    });

    it("event_id есть — ключ из него, как раньше", async () => {
      expect(await eventsOf(events.messagesDenied)).toEqual([
        { type: "blocked", dedupeKey: "vk:bot-1:0a3a3a3a1b4b4b4b2c5c5c5c3d6d6d6d4e7e7e7e", userId: "5550001" },
      ]);
    });
  });

  it("беседы, исходящие сообщения и чужие события не создают событий", async () => {
    expect(await eventsOf(events.groupChatMessage)).toEqual([]);
    expect(await eventsOf(events.outgoingMessage)).toEqual([]);
    expect(await eventsOf(events.wallPostNew)).toEqual([]);
  });

  it("ключ повтора: тот же event_id — тот же ключ, у другого бота — другой", async () => {
    const first = await eventsOf(events.startWithRef);
    const repeat = await eventsOf(events.startWithRef);
    const other = await adapter.parseWebhook(webhook(events.startWithRef), { ...bot, id: "bot-2" });
    expect(repeat).toEqual(first);
    expect(other.kind === "events" && other.events[0]).toMatchObject({
      dedupeKey: "vk:bot-2:1a1a1a1a2b2b2b2b3c3c3c3c4d4d4d4d5e5e5e5e",
    });
  });

  describe("коды в ref ссылки vk.me", () => {
    it("ссылка лидмагнита — обычное сообщение с кодом", async () => {
      expect(await eventsOf(events.leadMagnetLink)).toEqual([expect.objectContaining({ type: "message", startCode: "Ab3dE5gH" })]);
    });

    it.each(["a", "video_01", "a".repeat(12), "a".repeat(41)])("рекламная метка лидмагнита доходит целиком: %s", async (label) => {
      const code = `69diuTcj__ad_campaign__${label}`;
      const body = { ...events.leadMagnetLink, object: { ...events.leadMagnetLink.object,
        message: { ...events.leadMagnetLink.object.message, ref: code, ref_source: code } } };
      expect(await eventsOf(body)).toEqual([expect.objectContaining({ type: "message", startCode: code })]);
      const onlyRefSource = { ...body, object: { ...body.object, message: { ...body.object.message, ref: undefined } } };
      expect(await eventsOf(onlyRefSource)).toEqual([expect.objectContaining({ type: "message", startCode: code })]);
    });

    it("рекламная метка в ref — обычное сообщение, дальше решает маршрутизация (лидмагнит без кода)", async () => {
      expect(await eventsOf(events.adRef)).toEqual([
        expect.objectContaining({ type: "message", text: "Начать", startCode: "vk_ads_autumn" }),
      ]);
    });
  });

  it("у события нет event_id — ключ строится из типа, человека и сообщения, и он стабилен", async () => {
    const { event_id: _eventId, ...withoutEventId } = events.plainText;
    const [first] = await eventsOf(withoutEventId);
    const [second] = await eventsOf(withoutEventId);
    expect(first).toMatchObject({ dedupeKey: expect.stringMatching(/^vk:bot-1:message_new:5550001:/) });
    expect(second).toEqual(first);
  });
});

describe("отправка", () => {
  const sentTexts = () => api.callsTo("messages.send").map((call) => call.params.message);
  const send = (text: string, extra: Partial<Parameters<typeof adapter.send>[2]> = {}) =>
    adapter.send(bot, "5550001", { text, idempotencyKey: "k1", ...extra });

  it("текст: messages.send с peer_id и ключом сообщества, номер сообщения из ответа", async () => {
    const result = await send("Привет!");
    expect(result).toEqual({ ok: true, externalMessageId: "4001" });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.params).toMatchObject({
      peer_id: "5550001",
      message: "Привет!",
      access_token: bot.token,
      v: VK_API_VERSION,
    });
    expect(api.requests[0]?.params).not.toHaveProperty("keyboard");
    expect(api.requests[0]?.params).not.toHaveProperty("attachment");
  });

  it("random_id — целое от 1 до 2^31−1, и один и тот же для одного ключа повтора", async () => {
    await send("Привет!");
    await send("Привет!");
    await send("Привет!", { idempotencyKey: "k2" });
    const ids = api.callsTo("messages.send").map((call) => Number(call.params.random_id));
    for (const id of ids) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(2 ** 31 - 1);
    }
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("random_id у частей одного сообщения разные, а при повторе части — прежний", async () => {
    const text = `${"а".repeat(3000)}\n\n${"б".repeat(3000)}`;
    await send(text);
    const [first, second] = api.callsTo("messages.send").map((call) => call.params.random_id);
    expect(first).not.toBe(second);

    api.requests.length = 0;
    await send(text, { sentParts: 1 });
    expect(api.callsTo("messages.send")[0]?.params.random_id).toBe(second);
  });

  it("кнопки: inline-клавиатура, по одной в ряду, callback с нашими данными", async () => {
    await send("Выберите", {
      buttons: [
        { label: "Первый", payload: "menu:1" },
        { label: "Второй", payload: "menu:2" },
      ],
    });
    const keyboard = JSON.parse(api.callsTo("messages.send")[0]?.params.keyboard ?? "null");
    expect(keyboard).toEqual({
      inline: true,
      buttons: [
        [{ action: { type: "callback", label: "Первый", payload: '{"p":"menu:1"}' } }],
        [{ action: { type: "callback", label: "Второй", payload: '{"p":"menu:2"}' } }],
      ],
    });
  });

  it("надпись на кнопке длиннее 40 знаков — постоянная ошибка без запроса к ВК", async () => {
    const result = await send("Выберите", { buttons: [{ label: "я".repeat(41), payload: "menu:1" }] });
    expect(result).toMatchObject({ ok: false, reason: "permanent" });
    expect(api.requests).toHaveLength(0);
  });

  it("данные кнопки длиннее 255 байт — постоянная ошибка без запроса к ВК", async () => {
    const result = await send("Выберите", { buttons: [{ label: "Длинная", payload: "я".repeat(130) }] });
    expect(result).toMatchObject({ ok: false, reason: "permanent" });
    expect(api.requests).toHaveLength(0);
  });

  it("картинка из файла: сервер загрузки → загрузка → сохранение → одно сообщение с вложением и текстом", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vk-adapter-"));
    const imagePath = join(dir, "cover.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await send("Подпись", { imagePath });

    expect(result).toEqual({ ok: true, externalMessageId: "4001" });
    expect(api.requests.map((request) => request.method)).toEqual([
      "photos.getMessagesUploadServer",
      "photos.saveMessagesPhoto",
      "messages.send",
    ]);
    expect(api.callsTo("photos.getMessagesUploadServer")[0]?.params).toMatchObject({ peer_id: "5550001", access_token: bot.token });
    expect(api.uploads).toHaveLength(1);
    expect(api.uploads[0]?.url).toBe(UPLOAD_URL);
    expect((api.uploads[0]?.form.get("photo") as File).name).toBe("cover.png");
    expect(api.callsTo("photos.saveMessagesPhoto")[0]?.params).toMatchObject({ server: "999001", hash: "h4sh" });
    expect(api.callsTo("photos.saveMessagesPhoto")[0]?.params.photo).toContain("markers_restarted");
    expect(api.callsTo("messages.send")[0]?.params).toMatchObject({ message: "Подпись", attachment: "photo-222333_456239017" });
  });

  it("картинка со ссылкой доступа: ключ доступа входит во вложение", async () => {
    api.replyOnce("photos.saveMessagesPhoto", {
      status: 200,
      body: { response: [{ id: 7, owner_id: -222333, access_key: "abc123" }] },
    });
    api.serveFile("https://cdn.test/cover.png", Buffer.from([1, 2, 3]));
    await send("Подпись", { imagePath: "https://cdn.test/cover.png" });
    expect(api.callsTo("messages.send")[0]?.params.attachment).toBe("photo-222333_7_abc123");
  });

  it("картинка по ссылке: ВК ссылки не берёт, картинка скачивается и загружается", async () => {
    api.serveFile("https://cdn.test/cover.png", Buffer.from([1, 2, 3]));
    await send("Подпись", { imagePath: "https://cdn.test/cover.png" });
    expect(api.uploads).toHaveLength(1);
    expect((api.uploads[0]?.form.get("photo") as File).name).toBe("cover.png");
  });

  it("картинку по ссылке не скачать (404) — постоянная ошибка, в ВК ничего не ушло", async () => {
    api.serveFile("https://cdn.test/gone.png", Buffer.from([]), 404);
    const result = await send("Подпись", { imagePath: "https://cdn.test/gone.png" });
    expect(result).toMatchObject({ ok: false, reason: "permanent" });
    expect(api.callsTo("messages.send")).toHaveLength(0);
  });

  it("файла картинки нет — постоянная ошибка", async () => {
    expect(await send("x", { imagePath: "/no/such/file.png" })).toMatchObject({ ok: false, reason: "permanent" });
  });

  it("пустой текст с картинкой: уходит одно сообщение с вложением без текста", async () => {
    api.serveFile("https://cdn.test/cover.png", Buffer.from([1]));
    const result = await send("", { imagePath: "https://cdn.test/cover.png" });
    expect(result).toEqual({ ok: true, externalMessageId: "4001" });
    expect(api.callsTo("messages.send")).toHaveLength(1);
    expect(api.callsTo("messages.send")[0]?.params).not.toHaveProperty("message");
    expect(api.callsTo("messages.send")[0]?.params).toHaveProperty("attachment");
  });

  it("картинка и длинный текст: вложение — в первом сообщении, остальной текст — следующими", async () => {
    api.serveFile("https://cdn.test/cover.png", Buffer.from([1]));
    await send(`${"а".repeat(3000)}\n\n${"б".repeat(3000)}`, { imagePath: "https://cdn.test/cover.png" });
    const [first, second] = api.callsTo("messages.send");
    expect(first?.params).toMatchObject({ message: "а".repeat(3000), attachment: "photo-222333_456239017" });
    expect(second?.params.message).toBe("б".repeat(3000));
    expect(second?.params).not.toHaveProperty("attachment");
  });

  it("загрузка фото не удалась на стороне ВК — temporary, картинка не считается ушедшей", async () => {
    api.serveFile("https://cdn.test/cover.png", Buffer.from([1]));
    api.replyToUploadOnce({ status: 500, body: "boom" });
    expect(await send("x", { imagePath: "https://cdn.test/cover.png" })).toMatchObject({
      ok: false,
      reason: "temporary",
      sentParts: 0,
    });
  });

  it.each([
    [900, "Can't send messages for users from blacklist"],
    [901, "Can't send messages for users without permission"],
    [902, "Can't send messages to this user due to their privacy settings"],
  ])("ошибка %i (человек не разрешил или запретил сообщения) → blocked", async (code, message) => {
    api.replyOnce("messages.send", vkError(code, message));
    expect(await send("x")).toEqual({ ok: false, reason: "blocked" });
  });

  it("ошибка 950 (окно ответа закрыто) → reply_window_closed, а не blocked и не повтор", async () => {
    api.replyOnce("messages.send", vkError(950, "Can't send message, reply timed out"));
    expect(await send("x")).toEqual({ ok: false, reason: "reply_window_closed" });
  });

  it.each([
    [917, "You don't have access to this chat"],
    [925, "You are not admin of this chat"],
  ])("ошибка %i касается беседы, а не человека → permanent, не blocked (мы пишем только в личные)", async (code, message) => {
    api.replyOnce("messages.send", vkError(code, message));
    expect(await send("x")).toEqual({ ok: false, reason: "permanent", error: message, sentParts: 0 });
  });

  it("ошибка 6 (слишком часто) → rate_limited с паузой по умолчанию 1 секунда", async () => {
    api.replyOnce("messages.send", vkError(6, "Too many requests per second"));
    expect(await send("x")).toEqual({ ok: false, reason: "rate_limited", retryAfterMs: 1000, sentParts: 0 });
  });

  it("ошибка 29 (исчерпан суточный лимит метода) → temporary: попытки считаются, пауза растёт, вечного повтора нет", async () => {
    api.replyOnce("messages.send", vkError(29, "Rate limit reached"));
    expect(await send("x")).toEqual({ ok: false, reason: "temporary", error: "Rate limit reached", sentParts: 0 });
  });

  it.each([
    [5, "User authorization failed"],
    [100, "One of the parameters specified was missing or invalid"],
    [914, "Message is too long"],
  ])("ошибка %i → permanent с пояснением ВК", async (code, message) => {
    api.replyOnce("messages.send", vkError(code, message));
    expect(await send("x")).toEqual({ ok: false, reason: "permanent", error: message, sentParts: 0 });
  });

  it.each([
    ["ошибка 10, сбой ВК", vkError(10, "Internal server error")],
    ["ошибка 9, однотипные сообщения (повторять можно, но не бесконечно)", vkError(9, "Flood control")],
    ["ответ не от ВК (502)", { status: 502, body: "<html>Bad Gateway</html>" }],
  ])("%s → temporary", async (_name, reply) => {
    api.replyOnce("messages.send", reply);
    expect(await send("x")).toMatchObject({ ok: false, reason: "temporary" });
  });

  it("сеть упала → temporary, ключа в тексте ошибки нет", async () => {
    api.replyOnce("messages.send", new Error(`fetch failed access_token=${bot.token}`));
    const result = await send("x");
    expect(result).toMatchObject({ ok: false, reason: "temporary" });
    expect(JSON.stringify(result)).not.toContain(bot.token);
  });
});

describe("отправка: длинный текст, пустой текст, части", () => {
  const send = (text: string, extra: Partial<Parameters<typeof adapter.send>[2]> = {}) =>
    adapter.send(bot, "5550001", { text, idempotencyKey: "k1", ...extra });
  const sentTexts = () => api.callsTo("messages.send").map((call) => call.params.message);

  it("ровно 4096 знаков — одно сообщение", async () => {
    await send("а".repeat(4096));
    expect(sentTexts()).toEqual(["а".repeat(4096)]);
  });

  it("длиннее 4096 режется по границе абзаца", async () => {
    const result = await send(`${"а".repeat(3000)}\n\n${"б".repeat(3000)}`);
    expect(sentTexts()).toEqual(["а".repeat(3000), "б".repeat(3000)]);
    expect(result).toEqual({ ok: true, externalMessageId: "4001" });
  });

  it("нет ни пробелов, ни переносов — режется жёстко по 4096", async () => {
    await send("а".repeat(9000));
    expect(sentTexts().map((text) => text?.length)).toEqual([4096, 4096, 808]);
  });

  it("эмодзи не режется посередине", async () => {
    await send("😀".repeat(3000));
    for (const part of sentTexts()) expect(part).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(sentTexts().join("")).toBe("😀".repeat(3000));
  });

  it("кнопки — только на последней части", async () => {
    await send(`${"а".repeat(3000)}\n\n${"б".repeat(3000)}`, { buttons: [{ label: "Дальше", payload: "next" }] });
    const [first, last] = api.callsTo("messages.send");
    expect(first?.params).not.toHaveProperty("keyboard");
    expect(JSON.parse(last?.params.keyboard ?? "null").buttons).toEqual([
      [{ action: { type: "callback", label: "Дальше", payload: '{"p":"next"}' } }],
    ]);
  });

  it("пустой текст без картинки: в ВК ничего не уходит, результат «empty»", async () => {
    expect(await send("")).toEqual({ ok: false, reason: "empty" });
    expect(await send("  \n ")).toEqual({ ok: false, reason: "empty" });
    expect(api.requests).toEqual([]);
  });

  it("дополнительные сообщения (ролик, прощание) уходят после основного по порядку, кнопки — на основном", async () => {
    const result = await send("Ответ", { followUps: ["▶ Ролик\nhttps://youtu.be/x", "Пока!"], buttons: [{ label: "Дальше", payload: "next" }] });
    expect(result).toMatchObject({ ok: true });
    expect(sentTexts()).toEqual(["Ответ", "▶ Ролик\nhttps://youtu.be/x", "Пока!"]);
    const [first, , last] = api.callsTo("messages.send");
    expect(JSON.parse(first?.params.keyboard ?? "null").buttons).toHaveLength(1);
        expect(last?.params).not.toHaveProperty("keyboard");
  });

  it("сбой на дополнительном сообщении: повтор шлёт только остаток", async () => {
    api.replyOnce("messages.send", { status: 200, body: { response: 1 } });
    api.replyOnce("messages.send", vkError(10, "Internal server error"));
    const failed = await send("Ответ", { followUps: ["Ролик", "Пока!"] });
    expect(failed).toMatchObject({ ok: false, reason: "temporary", sentParts: 1 });

    api.requests.length = 0;
    expect(await send("Ответ", { followUps: ["Ролик", "Пока!"], sentParts: 1 })).toMatchObject({ ok: true });
    expect(sentTexts()).toEqual(["Ролик", "Пока!"]);
  });

  it("пустой основной текст: уходят только дополнительные сообщения", async () => {
    expect(await send("", { followUps: ["Ролик"] })).toMatchObject({ ok: true });
    expect(sentTexts()).toEqual(["Ролик"]);
  });

  it("сбой на второй части длинного текста: первая считается ушедшей, повтор шлёт только остаток", async () => {
    const text = `${"а".repeat(3000)}\n\n${"б".repeat(3000)}\n\n${"в".repeat(3000)}`;
    api.replyOnce("messages.send", { status: 200, body: { response: 1 } });
    api.replyOnce("messages.send", vkError(10, "Internal server error"));
    const failed = await send(text);
    expect(failed).toMatchObject({ ok: false, reason: "temporary", sentParts: 1 });

    api.requests.length = 0;
    const retried = await send(text, { sentParts: 1 });
    expect(retried).toMatchObject({ ok: true });
    expect(sentTexts()).toEqual(["б".repeat(3000), "в".repeat(3000)]);
  });

  it("сбой на первой же части: sentParts равен нулю", async () => {
    api.replyOnce("messages.send", vkError(10, "Internal server error"));
    expect(await send("привет")).toMatchObject({ ok: false, reason: "temporary", sentParts: 0 });
  });

  it("прошлый прогресс входит в счёт: sentParts: 1, сбой на следующей части — sentParts: 1", async () => {
    const text = `${"а".repeat(3000)}\n\n${"б".repeat(3000)}`;
    api.replyOnce("messages.send", vkError(10, "Internal server error"));
    expect(await send(text, { sentParts: 1 })).toMatchObject({ ok: false, sentParts: 1 });
  });

  it("sentParts больше, чем частей (потеряли прогресс): лучше повторить последнюю часть, чем потерять", async () => {
    expect(await send("привет", { sentParts: 5 })).toMatchObject({ ok: true });
    expect(sentTexts()).toEqual(["привет"]);
  });

  it("повтор с sentParts: 1 после картинки в первом сообщении не загружает фото второй раз", async () => {
    const text = `${"а".repeat(3000)}\n\n${"б".repeat(3000)}`;
    await send(text, { imagePath: "https://cdn.test/never-fetched.png", sentParts: 1 });
    expect(api.requests.map((request) => request.method)).toEqual(["messages.send"]);
    expect(api.uploads).toHaveLength(0);
  });
});

describe("кнопки и ссылка входа", () => {
  it("answerButton: sendMessageEventAnswer с event_id, user_id и peer_id из нажатия", async () => {
    await adapter.answerButton?.(bot, "5550001|5550002|ev-5550001-1790000010");
    expect(api.callsTo("messages.sendMessageEventAnswer")[0]?.params).toMatchObject({
      event_id: "ev-5550001-1790000010",
      user_id: "5550001",
      peer_id: "5550002",
      access_token: bot.token,
    });
  });

  it("answerButton: ВК отказал — ошибка (вызывающий её перехватит)", async () => {
    api.replyOnce("messages.sendMessageEventAnswer", vkError(100, "Invalid event_id"));
    await expect(adapter.answerButton?.(bot, "1|1|bad")).rejects.toThrow("Invalid event_id");
  });

  it("answerButton: непонятный идентификатор — ошибка без запроса к ВК", async () => {
    await expect(adapter.answerButton?.(bot, "мусор")).rejects.toThrow();
    expect(api.requests).toEqual([]);
  });

  it("entryLink: vk.me/<сообщество>?ref=<код>&ref_source=<код>", () => {
    expect(adapter.entryLink({ username: "live_magnet_club", externalId: "222333" }, "Ab3dE5gH")).toBe(
      "https://vk.me/live_magnet_club?ref=Ab3dE5gH&ref_source=Ab3dE5gH",
    );
  });

  it("entryLink: нет короткого адреса — club<id>", () => {
    expect(adapter.entryLink({ username: "", externalId: "222333" }, "Ab3dE5gH")).toBe(
      "https://vk.me/club222333?ref=Ab3dE5gH&ref_source=Ab3dE5gH",
    );
  });

  it("kind и скорость отправки", () => {
    expect(adapter.kind).toBe("vk");
    expect(adapter.ratePerSecond).toBeGreaterThan(0);
  });
});
