import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { BotCredentials, ChannelEvent, WebhookRequest } from "../channel";
import { createMaxAdapter, MAX_SECRET_HEADER } from "./adapter";
import { FakeMaxApi, maxError, UPLOAD_URL } from "./fake-max-api";
import * as updates from "./recorded-updates";

const API_BASE = "https://max-api.test";
const WEBHOOK_URL = "https://livem.test/api/webhooks/max/bot-1";
const bot: BotCredentials = {
  id: "bot-1",
  token: "max-secret-bot-token",
  externalId: "123456",
  username: "live_magnet_bot",
  // «_» Max в секрете не принимает: адаптер заменяет его на букву
  webhookSecret: "hook_secret-1",
};

let api: FakeMaxApi;
let adapter: ReturnType<typeof createMaxAdapter>;

beforeEach(() => {
  api = new FakeMaxApi();
  adapter = createMaxAdapter({ apiBaseUrl: API_BASE, fetch: api.fetch });
});

/** Секрет, с которым адаптер подписал вебхук: именно он должен прийти в заголовке. */
async function secretSentOnConnect(): Promise<string> {
  await adapter.connect(bot, WEBHOOK_URL);
  return String(api.callsTo("POST /subscriptions")[0]?.body && (api.callsTo("POST /subscriptions")[0]?.body as { secret: string }).secret);
}

/** `secret = null` — запрос без заголовка с секретом. */
async function webhook(update: unknown, secret?: string | null): Promise<WebhookRequest> {
  const value = secret === undefined ? await secretSentOnConnect() : secret;
  return { headers: value === null ? {} : { [MAX_SECRET_HEADER]: value }, body: JSON.stringify(update) };
}

async function eventsOf(update: unknown): Promise<ChannelEvent[]> {
  const parsed = await adapter.parseWebhook(await webhook(update), bot);
  if (parsed.kind !== "events") throw new Error(`Ожидались события, получено ${parsed.kind}`);
  return parsed.events;
}

describe("подключение бота", () => {
  it("verifyToken: GET /me с токеном в заголовке Authorization, id, адрес и имя бота", async () => {
    const identity = await adapter.verifyToken(bot.token);
    expect(identity).toEqual({ externalId: "123456", username: "live_magnet_bot", title: "Живой лидмагнит" });
    expect(api.requests).toEqual([{ route: "GET /me", query: {}, authorization: bot.token, body: undefined }]);
  });

  it("verifyToken: неверный токен (401) — понятная ошибка, токена в тексте нет", async () => {
    api.replyOnce("GET /me", maxError(401, "verify.token", `Invalid access_token ${bot.token}`));
    const error = await adapter.verifyToken(bot.token).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Неверный токен бота");
    expect((error as Error).message).not.toContain(bot.token);
  });

  it("verifyToken: сбой Max — ошибка с пояснением", async () => {
    api.replyOnce("GET /me", maxError(500, "internal.error", "Что-то сломалось"));
    await expect(adapter.verifyToken(bot.token)).rejects.toThrow("Что-то сломалось");
  });

  it("по умолчанию ходит на platform-api.max.ru", async () => {
    const calls: string[] = [];
    const direct = createMaxAdapter({
      fetch: async (input) => {
        calls.push(input.toString());
        return new Response(JSON.stringify({ user_id: 1, first_name: "B", username: "b_bot" }));
      },
    });
    await direct.verifyToken("t");
    expect(calls).toEqual(["https://platform-api.max.ru/me"]);
  });

  it("verifyToken: у бота нет username — пустая строка, название из first_name", async () => {
    api.replyOnce("GET /me", { status: 200, body: { user_id: 9, first_name: "Без имени", is_bot: true } });
    expect(await adapter.verifyToken(bot.token)).toEqual({ externalId: "9", username: "", title: "Без имени" });
  });

  it("connect: POST /subscriptions с адресом, секретом и ровно четырьмя нужными событиями", async () => {
    await adapter.connect(bot, WEBHOOK_URL);
    const [call] = api.callsTo("POST /subscriptions");
    expect(call?.authorization).toBe(bot.token);
    expect(call?.body).toMatchObject({ url: WEBHOOK_URL });
    expect((call?.body as { update_types: string[] }).update_types.sort()).toEqual([
      "bot_started",
      "bot_stopped",
      "message_callback",
      "message_created",
    ]);
  });

  it("connect: секрет — только латинские буквы, цифры и дефис, от 5 до 256 знаков", async () => {
    expect(await secretSentOnConnect()).toMatch(/^[A-Za-z0-9-]{5,256}$/);
  });

  it("connect: Max ответил success: false — ошибка с его пояснением", async () => {
    api.replyOnce("POST /subscriptions", { status: 200, body: { success: false, message: "Не удалось проверить сертификат" } });
    await expect(adapter.connect(bot, WEBHOOK_URL)).rejects.toThrow("Не удалось проверить сертификат");
  });

  it("connect: Max отклонил запрос (400) — ошибка с его пояснением", async () => {
    api.replyOnce("POST /subscriptions", maxError(400, "proto.payload", "Webhook url must be https on port 443"));
    await expect(adapter.connect(bot, "http://localhost/hook")).rejects.toThrow("Webhook url must be https");
  });

  it("disconnect: удаляет подписки с адресом этого бота, чужие не трогает", async () => {
    api.replyOnce("GET /subscriptions", {
      status: 200,
      body: {
        subscriptions: [
          { url: "https://livem.test/api/webhooks/max/bot-1", time: 1, update_types: ["message_created"], version: "0.0.1" },
          { url: "https://livem.test/api/webhooks/max/bot-2", time: 1, update_types: ["message_created"], version: "0.0.1" },
          { url: "https://other.test/hook", time: 1, update_types: ["message_created"], version: "0.0.1" },
        ],
      },
    });
    await adapter.disconnect(bot, WEBHOOK_URL);
    expect(api.callsTo("DELETE /subscriptions").map((call) => call.query)).toEqual([{ url: "https://livem.test/api/webhooks/max/bot-1" }]);
  });

  it("disconnect: адрес сравнивается целиком — чужая подписка с таким же хвостом не удаляется", async () => {
    api.replyOnce("GET /subscriptions", {
      status: 200,
      body: {
        subscriptions: [
          { url: "https://other.test/api/webhooks/max/bot-1", time: 1, update_types: ["message_created"], version: "0.0.1" },
          { url: "https://livem.test/old/api/webhooks/max/bot-1", time: 1, update_types: ["message_created"], version: "0.0.1" },
          { url: WEBHOOK_URL, time: 1, update_types: ["message_created"], version: "0.0.1" },
        ],
      },
    });
    await adapter.disconnect(bot, WEBHOOK_URL);
    expect(api.callsTo("DELETE /subscriptions").map((call) => call.query)).toEqual([{ url: WEBHOOK_URL }]);
  });

  it("checkConnection: GET /me отвечает — всё хорошо", async () => {
    expect(await adapter.checkConnection(bot)).toEqual({ ok: true });
    expect(api.requests[0]).toMatchObject({ route: "GET /me", authorization: bot.token });
  });

  it("checkConnection: 401 — токен отозван (invalid_token)", async () => {
    api.replyOnce("GET /me", maxError(401, "verify.token", "Invalid access_token"));
    expect(await adapter.checkConnection(bot)).toEqual({ ok: false, kind: "invalid_token", error: "Invalid access_token" });
  });

  it.each([
    ["429, слишком часто", maxError(429, "too.many.requests", "Too many requests"), "Too many requests"],
    ["Max ответил 500", maxError(500, "internal.error", "Internal error"), "Internal error"],
    ["прокси отдал 502 не от Max", { status: 502, body: "<html>Bad Gateway</html>" }, "502"],
    ["сеть упала", new Error("connect ECONNREFUSED"), "ECONNREFUSED"],
  ])("checkConnection: %s — временный сбой (temporary)", async (_name, reply, text) => {
    api.replyOnce("GET /me", reply);
    const result = await adapter.checkConnection(bot);
    expect(result).toMatchObject({ ok: false, kind: "temporary" });
    expect(JSON.stringify(result)).toContain(text);
  });

  it("checkConnection: токена в тексте сбоя нет", async () => {
    api.replyOnce("GET /me", new Error(`fetch failed, Authorization: ${bot.token}`));
    expect(JSON.stringify(await adapter.checkConnection(bot))).not.toContain(bot.token);
  });

  it("checkConnection: зависший запрос (таймаут) — временный сбой, а не исключение", async () => {
    const hanging = createMaxAdapter({
      requestTimeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    expect(await hanging.checkConnection(bot)).toMatchObject({ ok: false, kind: "temporary" });
  });
});

describe("разбор вебхука: секрет", () => {
  it("секрет из подписки приходит в заголовке X-Max-Bot-Api-Secret — события разобраны", async () => {
    expect(MAX_SECRET_HEADER).toBe("x-max-bot-api-secret");
    expect((await adapter.parseWebhook(await webhook(updates.plainText), bot)).kind).toBe("events");
  });

  it("неверный секрет — rejected", async () => {
    expect(await adapter.parseWebhook(await webhook(updates.plainText, "чужой"), bot)).toEqual({ kind: "rejected" });
  });

  it("секрета нет — rejected", async () => {
    expect(await adapter.parseWebhook(await webhook(updates.plainText, null), bot)).toEqual({ kind: "rejected" });
  });

  it("секрет другой длины — rejected, а не ошибка", async () => {
    expect(await adapter.parseWebhook(await webhook(updates.plainText, "x"), bot)).toEqual({ kind: "rejected" });
  });

  it("верный секрет, но тело не JSON — rejected", async () => {
    const request = { headers: { [MAX_SECRET_HEADER]: await secretSentOnConnect() }, body: "<html>" };
    expect(await adapter.parseWebhook(request, bot)).toEqual({ kind: "rejected" });
  });

  it("верный секрет, но тело — не объект — rejected", async () => {
    expect(await adapter.parseWebhook(await webhook([1]), bot)).toEqual({ kind: "rejected" });
  });

  it("ответ на вебхук — пустая строка", async () => {
    expect(await adapter.parseWebhook(await webhook(updates.plainText), bot)).toMatchObject({ kind: "events", responseBody: "" });
  });
});

describe("разбор вебхука: обновления", () => {
  it("bot_started с payload — сообщение «/start <код>» с startCode (как /start в Telegram)", async () => {
    expect(await eventsOf(updates.startWithPayload)).toEqual([
      {
        type: "message",
        dedupeKey: "max:bot-1:bot_started:5550001:1790000001000",
        userId: "5550001",
        userName: "Анна Петрова",
        text: "/start Ab3dE5gH",
        startCode: "Ab3dE5gH",
      },
    ]);
  });

  it("рекламный payload передаётся целиком из bot_started", async () => {
    const code = "69diuTcj__ad_campaign__video_01";
    expect((await eventsOf({ ...updates.startWithPayload, payload: code }))[0]).toMatchObject({ type: "message", startCode: code });
  });

  it("bot_started без payload — «/start», startCode нет", async () => {
    const [event] = await eventsOf(updates.startWithoutPayload);
    expect(event).toMatchObject({ type: "message", text: "/start" });
    expect(event).not.toHaveProperty("startCode");
  });

  it("bot_started: payload в предельные 128 знаков передаётся целиком", async () => {
    const [event] = await eventsOf(updates.startWithLongestPayload);
    expect(event).toMatchObject({ startCode: updates.LONGEST_PAYLOAD });
  });

  it("message_created: обычный текст, ключ повтора — message.body.mid", async () => {
    expect(await eventsOf(updates.plainText)).toEqual([
      {
        type: "message",
        dedupeKey: "max:bot-1:mid.0000000000a1b2c3",
        userId: "5550001",
        userName: "Анна Петрова",
        text: "Хочу научиться делать рассылки",
      },
    ]);
  });

  it("message_created без mid — ключ из типа обновления, человека и времени", async () => {
    const [event] = await eventsOf(updates.textWithoutMid);
    expect(event).toMatchObject({ dedupeKey: "max:bot-1:message_created:5550001:1790000011000" });
  });

  it("имя: нет составного имени — собирается из имени и фамилии, потом из username; нет ничего — поля нет", async () => {
    const withoutName = {
      ...updates.plainText,
      message: { ...updates.plainText.message, sender: { user_id: 9, first_name: "Мария", last_name: "Иванова", is_bot: false } },
    };
    expect((await eventsOf(withoutName))[0]).toMatchObject({ userName: "Мария Иванова" });
    const onlyUsername = {
      ...updates.plainText,
      message: { ...updates.plainText.message, sender: { user_id: 9, first_name: "", username: "ghost", is_bot: false } },
    };
    expect((await eventsOf(onlyUsername))[0]).toMatchObject({ userName: "ghost" });
    const nothing = {
      ...updates.plainText,
      message: { ...updates.plainText.message, sender: { user_id: 9, first_name: "", is_bot: false } },
    };
    expect((await eventsOf(nothing))[0]).not.toHaveProperty("userName");
  });

  it("обычный текст — без startCode и вложения", async () => {
    const [event] = await eventsOf(updates.plainText);
    expect(event).not.toHaveProperty("startCode");
    expect(event).not.toHaveProperty("attachment");
  });

  it.each([
    ["фото", updates.photoWithCaption, "image", "Вот мой текущий сайт"],
    ["голосовое (в Max это audio)", updates.voiceMessage, "voice", ""],
    ["стикер", updates.stickerMessage, "sticker", ""],
    ["файл", updates.fileMessage, "file", "Бриф"],
    ["видео", updates.videoMessage, "other", ""],
    ["геопозиция", updates.locationMessage, "other", ""],
  ] as const)("вложение: %s", async (_name, update, attachment, text) => {
    expect(await eventsOf(update)).toEqual([expect.objectContaining({ type: "message", attachment, text })]);
  });

  it("ссылка с превью Max (вложение share) — просто текст: превью не вложение человека", async () => {
    const [event] = await eventsOf(updates.linkWithPreview);
    expect(event).toMatchObject({ type: "message", text: "https://koleso-uzhina.apps.example.com/" });
    expect(event).not.toHaveProperty("attachment");
  });

  it("message_callback: нажатие кнопки — button; ключ повтора — callback_id", async () => {
    expect(await eventsOf(updates.buttonPressed)).toEqual([
      {
        type: "button",
        dedupeKey: "max:bot-1:cb.Zm9vYmFy",
        userId: "5550001",
        callbackId: "cb.Zm9vYmFy",
        payload: "menu:lead-magnet-1",
      },
    ]);
  });

  it("bot_stopped: человек остановил бота — blocked; ключ — тип, человек, время", async () => {
    expect(await eventsOf(updates.botStoppedByUser)).toEqual([
      { type: "blocked", dedupeKey: "max:bot-1:bot_stopped:5550001:1790000013000", userId: "5550001" },
    ]);
  });

  it("групповые чаты, сообщения ботов, правки и прочие обновления не создают событий", async () => {
    expect(await eventsOf(updates.groupChatMessage)).toEqual([]);
    expect(await eventsOf(updates.messageFromAnotherBot)).toEqual([]);
    expect(await eventsOf(updates.messageEdited)).toEqual([]);
    expect(await eventsOf(updates.botAddedToChat)).toEqual([]);
  });

  it("ключ повтора: те же обновление и бот — тот же ключ, у другого бота — другой", async () => {
    const first = await eventsOf(updates.plainText);
    const repeat = await eventsOf(updates.plainText);
    const other = await adapter.parseWebhook(await webhook(updates.plainText), { ...bot, id: "bot-2" });
    expect(repeat).toEqual(first);
    expect(other.kind === "events" && other.events[0]).toMatchObject({ dedupeKey: "max:bot-2:mid.0000000000a1b2c3" });
  });
});

describe("отправка", () => {
  const send = (text: string, extra: Partial<Parameters<typeof adapter.send>[2]> = {}) =>
    adapter.send(bot, "5550001", { text, idempotencyKey: "k1", ...extra });
  const sentTexts = () => api.callsTo("POST /messages").map((call) => (call.body as { text?: string }).text);

  it("текст: POST /messages?user_id=…, токен в заголовке, номер сообщения — message.body.mid", async () => {
    const result = await send("Привет!");
    expect(result).toEqual({ ok: true, externalMessageId: "mid.0000000000a1b2c3" });
    expect(api.requests).toEqual([
      { route: "POST /messages", query: { user_id: "5550001" }, authorization: bot.token, body: { text: "Привет!" } },
    ]);
  });

  it("кнопки: inline_keyboard, по одной в ряду, callback с данными кнопки", async () => {
    await send("Выберите", {
      buttons: [
        { label: "Первый", payload: "menu:1" },
        { label: "Второй", payload: "menu:2" },
      ],
    });
    expect((api.callsTo("POST /messages")[0]?.body as { attachments: unknown[] }).attachments).toEqual([
      {
        type: "inline_keyboard",
        payload: {
          buttons: [
            [{ type: "callback", text: "Первый", payload: "menu:1" }],
            [{ type: "callback", text: "Второй", payload: "menu:2" }],
          ],
        },
      },
    ]);
  });

  it("данные кнопки длиннее 1024 знаков — постоянная ошибка без запроса к Max", async () => {
    const result = await send("Выберите", { buttons: [{ label: "Длинная", payload: "я".repeat(1025) }] });
    expect(result).toMatchObject({ ok: false, reason: "permanent" });
    expect(api.requests).toHaveLength(0);
  });

  it("картинка из файла: POST /uploads?type=image → загрузка → одно сообщение с токеном картинки и текстом", async () => {
    const dir = await mkdtemp(join(tmpdir(), "max-adapter-"));
    const imagePath = join(dir, "cover.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await send("Подпись", { imagePath });

    expect(result).toEqual({ ok: true, externalMessageId: "mid.0000000000a1b2c3" });
    expect(api.requests.map((request) => request.route)).toEqual(["POST /uploads", "POST /messages"]);
    expect(api.callsTo("POST /uploads")[0]).toMatchObject({ query: { type: "image" }, authorization: bot.token });
    expect(api.uploads).toHaveLength(1);
    expect(api.uploads[0]?.url).toBe(UPLOAD_URL);
    expect((api.uploads[0]?.form.get("data") as File).name).toBe("cover.png");
    expect(api.callsTo("POST /messages")[0]?.body).toEqual({
      text: "Подпись",
      attachments: [{ type: "image", payload: { token: "IMG-TOKEN-1" } }],
    });
  });

  it("картинка по ссылке: Max берёт ссылку сам, загрузка не нужна", async () => {
    await send("Подпись", { imagePath: "https://cdn.test/cover.png" });
    expect(api.requests.map((request) => request.route)).toEqual(["POST /messages"]);
    expect(api.callsTo("POST /messages")[0]?.body).toEqual({
      text: "Подпись",
      attachments: [{ type: "image", payload: { url: "https://cdn.test/cover.png" } }],
    });
  });

  it("картинка и кнопки: вложение картинки и клавиатуры в одном сообщении", async () => {
    await send("Подпись", { imagePath: "https://cdn.test/cover.png", buttons: [{ label: "Дальше", payload: "next" }] });
    const attachments = (api.callsTo("POST /messages")[0]?.body as { attachments: Array<{ type: string }> }).attachments;
    expect(attachments.map((attachment) => attachment.type)).toEqual(["image", "inline_keyboard"]);
  });

  it("картинка загрузилась, но ещё не обработана (attachment.not.ready) — temporary, повтор позже", async () => {
    api.replyOnce("POST /messages", maxError(400, "attachment.not.ready", "Key: errors.process.attachment.file.not.processed"));
    expect(await send("x", { imagePath: "https://cdn.test/cover.png" })).toMatchObject({
      ok: false,
      reason: "temporary",
      sentParts: 0,
    });
  });

  it("attachment.not.ready: при повторе тот же токен загруженной картинки, повторной загрузки нет", async () => {
    const dir = await mkdtemp(join(tmpdir(), "max-adapter-"));
    const imagePath = join(dir, "cover.png");
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    api.replyOnce("POST /messages", maxError(400, "attachment.not.ready", "Key: errors.process.attachment.file.not.processed"));

    expect(await send("Подпись", { imagePath })).toMatchObject({ ok: false, reason: "temporary" });
    expect(await send("Подпись", { imagePath })).toEqual({ ok: true, externalMessageId: "mid.0000000000a1b2c3" });

    expect(api.callsTo("POST /uploads")).toHaveLength(1);
    expect(api.uploads).toHaveLength(1);
    const bodies = api.callsTo("POST /messages").map((call) => call.body);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("токен загруженной картинки привязан к сообщению: другое сообщение с той же картинкой загружает заново", async () => {
    const dir = await mkdtemp(join(tmpdir(), "max-adapter-"));
    const imagePath = join(dir, "cover.png");
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    api.replyOnce("POST /messages", maxError(400, "attachment.not.ready", "not ready"));
    await send("Подпись", { imagePath, idempotencyKey: "k1" });
    await send("Подпись", { imagePath, idempotencyKey: "k2" });
    expect(api.uploads).toHaveLength(2);
  });

  it("токен запомнен только при attachment.not.ready: после успешной отправки он забывается", async () => {
    const dir = await mkdtemp(join(tmpdir(), "max-adapter-"));
    const imagePath = join(dir, "cover.png");
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    await send("Подпись", { imagePath });
    await send("Подпись", { imagePath });
    expect(api.uploads).toHaveLength(2);
  });

  it("сервер загрузки не принял файл — temporary, а не потеря", async () => {
    const dir = await mkdtemp(join(tmpdir(), "max-adapter-"));
    const imagePath = join(dir, "cover.png");
    await writeFile(imagePath, Buffer.from([1]));
    api.replyToUploadOnce({ status: 500, body: "boom" });
    expect(await send("x", { imagePath })).toMatchObject({ ok: false, reason: "temporary" });
    expect(api.callsTo("POST /messages")).toHaveLength(0);
  });

  it("файла картинки нет — постоянная ошибка", async () => {
    expect(await send("x", { imagePath: "/no/such/file.png" })).toMatchObject({ ok: false, reason: "permanent" });
  });

  it("пустой текст с картинкой: уходит одно сообщение с картинкой без текста", async () => {
    await send("", { imagePath: "https://cdn.test/cover.png" });
    expect(api.callsTo("POST /messages")).toHaveLength(1);
    expect(api.callsTo("POST /messages")[0]?.body).not.toHaveProperty("text");
  });

  it.each([
    [403, "chat.denied"],
    [403, "dialog.suspended"],
    [403, "dialog.removed"],
  ])("ответ %i с кодом %s (человек остановил бота или удалил диалог) → blocked", async (status, code) => {
    api.replyOnce("POST /messages", maxError(status, code));
    expect(await send("x")).toEqual({ ok: false, reason: "blocked" });
  });

  it("403 с неизвестным кодом (например, бот заморожен) — не «заблокирован»: иначе все люди пометятся заблокированными", async () => {
    api.replyOnce("POST /messages", maxError(403, "access.denied", "Бот приостановлен"));
    expect(await send("x")).toEqual({ ok: false, reason: "permanent", error: "Бот приостановлен", sentParts: 0 });
  });

  it("429 → rate_limited с паузой из Retry-After", async () => {
    api.replyOnce("POST /messages", maxError(429, "too.many.requests", "Too many requests", { "retry-after": "7" }));
    expect(await send("x")).toEqual({ ok: false, reason: "rate_limited", retryAfterMs: 7000, sentParts: 0 });
  });

  it("429 без Retry-After — пауза по умолчанию 1 секунда", async () => {
    api.replyOnce("POST /messages", maxError(429, "too.many.requests"));
    expect(await send("x")).toMatchObject({ reason: "rate_limited", retryAfterMs: 1000 });
  });

  it.each([
    [400, "proto.payload", "Некорректное сообщение"],
    [401, "verify.token", "Invalid access_token"],
    [404, "not.found", "Not found"],
  ])("%i → permanent с пояснением Max", async (status, code, message) => {
    api.replyOnce("POST /messages", maxError(status, code, message));
    expect(await send("x")).toEqual({ ok: false, reason: "permanent", error: message, sentParts: 0 });
  });

  it("5xx и ответ не от Max → temporary", async () => {
    api.replyOnce("POST /messages", maxError(500, "internal.error", "Internal error"));
    api.replyOnce("POST /messages", { status: 502, body: "<html>Bad Gateway</html>" });
    expect(await send("x")).toMatchObject({ reason: "temporary" });
    expect(await send("x")).toMatchObject({ reason: "temporary" });
  });

  it("сеть упала → temporary, токена в тексте ошибки нет", async () => {
    api.replyOnce("POST /messages", new Error(`fetch failed, Authorization: ${bot.token}`));
    const result = await send("x");
    expect(result).toMatchObject({ ok: false, reason: "temporary" });
    expect(JSON.stringify(result)).not.toContain(bot.token);
  });

  describe("длинный текст, пустой текст, части", () => {
    it("ровно 4000 знаков — одно сообщение", async () => {
      await send("а".repeat(4000));
      expect(sentTexts()).toEqual(["а".repeat(4000)]);
    });

    it("длиннее 4000 режется по границе абзаца", async () => {
      const result = await send(`${"а".repeat(3000)}\n\n${"б".repeat(3000)}`);
      expect(sentTexts()).toEqual(["а".repeat(3000), "б".repeat(3000)]);
      expect(result).toEqual({ ok: true, externalMessageId: "mid.0000000000a1b2c3" });
    });

    it("нет ни пробелов, ни переносов — режется жёстко по 4000", async () => {
      await send("а".repeat(9000));
      expect(sentTexts().map((text) => text?.length)).toEqual([4000, 4000, 1000]);
    });

    it("эмодзи не режется посередине", async () => {
      await send("😀".repeat(3000));
      for (const part of sentTexts()) expect(part).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(sentTexts().join("")).toBe("😀".repeat(3000));
    });

    it("кнопки — только на последней части", async () => {
      await send(`${"а".repeat(3000)}\n\n${"б".repeat(3000)}`, { buttons: [{ label: "Дальше", payload: "next" }] });
      const [first, last] = api.callsTo("POST /messages");
      expect(first?.body).not.toHaveProperty("attachments");
      expect((last?.body as { attachments: Array<{ type: string }> }).attachments.map((a) => a.type)).toEqual(["inline_keyboard"]);
    });

    it("картинка — только в первом сообщении", async () => {
      await send(`${"а".repeat(3000)}\n\n${"б".repeat(3000)}`, { imagePath: "https://cdn.test/cover.png" });
      const [first, second] = api.callsTo("POST /messages");
      expect(first?.body).toMatchObject({ text: "а".repeat(3000), attachments: [{ type: "image" }] });
      expect(second?.body).toEqual({ text: "б".repeat(3000) });
    });

    it("пустой текст без картинки: в Max ничего не уходит, результат «empty»", async () => {
      expect(await send("")).toEqual({ ok: false, reason: "empty" });
      expect(await send("  \n ")).toEqual({ ok: false, reason: "empty" });
      expect(api.requests).toEqual([]);
    });

    it("дополнительные сообщения (ролик, прощание) уходят после основного по порядку, кнопки — на основном", async () => {
      const result = await send("Ответ", { followUps: ["▶ Ролик\nhttps://youtu.be/x", "Пока!"], buttons: [{ label: "Дальше", payload: "next" }] });
      expect(result).toMatchObject({ ok: true });
      expect(sentTexts()).toEqual(["Ответ", "▶ Ролик\nhttps://youtu.be/x", "Пока!"]);
      const [first, , last] = api.callsTo("POST /messages");
      const types = (call: typeof first) => ((call?.body as { attachments?: Array<{ type: string }> }).attachments ?? []).map((attachment) => attachment.type);
          expect(types(first)).toEqual(["inline_keyboard"]);
          expect(types(last)).toEqual([]);
    });

    it("сбой на дополнительном сообщении: повтор шлёт только остаток", async () => {
      api.replyOnce("POST /messages", { status: 200, body: { message: { body: { mid: "m1" } } } });
      api.replyOnce("POST /messages", maxError(500, "internal.error", "Internal error"));
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
      api.replyOnce("POST /messages", { status: 200, body: { message: { body: { mid: "m1" } } } });
      api.replyOnce("POST /messages", maxError(500, "internal.error", "Internal error"));
      const failed = await send(text);
      expect(failed).toMatchObject({ ok: false, reason: "temporary", sentParts: 1 });

      api.requests.length = 0;
      const retried = await send(text, { sentParts: 1 });
      expect(retried).toMatchObject({ ok: true });
      expect(sentTexts()).toEqual(["б".repeat(3000), "в".repeat(3000)]);
    });

    it("429 на второй части: пауза, и sentParts: 1", async () => {
      const text = `${"а".repeat(3000)}\n\n${"б".repeat(3000)}`;
      api.replyOnce("POST /messages", { status: 200, body: { message: { body: { mid: "m1" } } } });
      api.replyOnce("POST /messages", maxError(429, "too.many.requests", "x", { "retry-after": "2" }));
      expect(await send(text)).toEqual({ ok: false, reason: "rate_limited", retryAfterMs: 2000, sentParts: 1 });
    });

    it("429 посреди цепочки: повтор продолжает с места остановки, части не дублируются", async () => {
      const text = `${"а".repeat(3000)}\n\n${"б".repeat(3000)}\n\n${"в".repeat(3000)}`;
      api.replyOnce("POST /messages", { status: 200, body: { message: { body: { mid: "m1" } } } });
      api.replyOnce("POST /messages", maxError(429, "too.many.requests", "x", { "retry-after": "2" }));
      const limited = await send(text);
      expect(limited).toEqual({ ok: false, reason: "rate_limited", retryAfterMs: 2000, sentParts: 1 });

      const retried = await send(text, { sentParts: limited.ok ? 0 : limited.sentParts });
      expect(retried).toMatchObject({ ok: true });
      // Часть «б» уходила в Max дважды, но первый раз он отказал (429); «а» — только раз
      expect(sentTexts()).toEqual(["а".repeat(3000), "б".repeat(3000), "б".repeat(3000), "в".repeat(3000)]);
    });

    it("сбой на первой же части: sentParts равен нулю", async () => {
      api.replyOnce("POST /messages", maxError(500, "internal.error", "Internal error"));
      expect(await send("привет")).toMatchObject({ ok: false, reason: "temporary", sentParts: 0 });
    });

    it("прошлый прогресс входит в счёт: sentParts: 1, сбой на следующей части — sentParts: 1", async () => {
      const text = `${"а".repeat(3000)}\n\n${"б".repeat(3000)}`;
      api.replyOnce("POST /messages", maxError(500, "internal.error", "Internal error"));
      expect(await send(text, { sentParts: 1 })).toMatchObject({ ok: false, sentParts: 1 });
    });

    it("sentParts больше, чем частей (потеряли прогресс): лучше повторить последнюю часть, чем потерять", async () => {
      expect(await send("привет", { sentParts: 5 })).toMatchObject({ ok: true });
      expect(sentTexts()).toEqual(["привет"]);
    });
  });
});

describe("кнопки и ссылка входа", () => {
  it("answerButton: POST /answers?callback_id=…", async () => {
    await adapter.answerButton?.(bot, "cb.Zm9vYmFy");
    expect(api.callsTo("POST /answers")).toEqual([
      expect.objectContaining({ query: { callback_id: "cb.Zm9vYmFy" }, authorization: bot.token }),
    ]);
  });

  it("answerButton: Max отказал — ошибка (вызывающий её перехватит)", async () => {
    api.replyOnce("POST /answers", maxError(400, "proto.payload", "Unknown callback"));
    await expect(adapter.answerButton?.(bot, "bad")).rejects.toThrow("Unknown callback");
  });

  it("entryLink: max.ru/<бот>?start=<код>", () => {
    expect(adapter.entryLink({ username: "live_magnet_bot", externalId: "123456" }, "Ab3dE5gH")).toBe(
      "https://max.ru/live_magnet_bot?start=Ab3dE5gH",
    );
  });

  it("kind и скорость отправки", () => {
    expect(adapter.kind).toBe("max");
    expect(adapter.ratePerSecond).toBeGreaterThan(0);
  });
});
