import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { BotCredentials, ChannelEvent, WebhookRequest } from "../channel";
import { createTelegramAdapter, TELEGRAM_SECRET_HEADER } from "./adapter";
import { FakeTelegramApi, getUpdatesConflict, telegramError, webhookInfo } from "./fake-telegram-api";
import * as updates from "./recorded-updates";

const API_BASE = "https://tg-proxy.test/telegram";
const bot: BotCredentials = {
  id: "bot-1",
  token: "123456789:AA-secret-token",
  externalId: "123456789",
  username: "live_magnet_bot",
  webhookSecret: "hook-secret_1",
};

const OUR_WEBHOOK = "https://livem.test/api/webhooks/telegram/bot-1";

let api: FakeTelegramApi;
let adapter: ReturnType<typeof createTelegramAdapter>;

beforeEach(() => {
  api = new FakeTelegramApi();
  adapter = createTelegramAdapter({ apiBaseUrl: API_BASE, fetch: api.fetch });
});

/** `secret = null` — запрос без заголовка с секретом. */
function webhook(update: unknown, secret: string | null = bot.webhookSecret): WebhookRequest {
  return {
    headers: secret === null ? {} : { [TELEGRAM_SECRET_HEADER]: secret },
    body: JSON.stringify(update),
  };
}

async function eventsOf(update: unknown): Promise<ChannelEvent[]> {
  const parsed = await adapter.parseWebhook(webhook(update), bot);
  if (parsed.kind !== "events") throw new Error(`Ожидались события, получено ${parsed.kind}`);
  return parsed.events;
}

describe("подключение бота", () => {
  it("verifyToken: getMe по адресу из настроек, имя и username бота", async () => {
    const identity = await adapter.verifyToken(bot.token);
    expect(identity).toEqual({ externalId: "123456789", username: "live_magnet_bot", title: "Живой лидмагнит" });
    expect(api.requests).toEqual([{ method: "getMe", token: bot.token, body: {} }]);
  });

  it("verifyToken: неверный токен — ошибка с пояснением Telegram, токена в тексте нет", async () => {
    api.replyOnce("getMe", telegramError(401, "Unauthorized"));
    const error = await adapter.verifyToken(bot.token).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Неверный токен бота");
    expect((error as Error).message).toContain("Unauthorized");
    expect((error as Error).message).not.toContain(bot.token);
  });

  it("verifyToken: токен неверной формы (Telegram отвечает 404) — тоже «неверный токен»", async () => {
    api.replyOnce("getMe", telegramError(404, "Not Found"));
    await expect(adapter.verifyToken("мусор")).rejects.toThrow("Неверный токен бота");
  });

  it("по умолчанию ходит на api.telegram.org", async () => {
    const calls: string[] = [];
    const direct = createTelegramAdapter({
      fetch: async (input) => {
        calls.push(input.toString());
        return new Response(JSON.stringify({ ok: true, result: { id: 1, first_name: "B", username: "b_bot" } }));
      },
    });
    await direct.verifyToken("1:abc");
    expect(calls).toEqual(["https://api.telegram.org/bot1:abc/getMe"]);
  });

  it("connect: setWebhook с адресом, секретом и нужными типами обновлений", async () => {
    await adapter.connect(bot, "https://livem.test/api/webhooks/telegram/bot-1");
    const [call] = api.callsTo("setWebhook");
    expect(call?.body).toMatchObject({
      url: "https://livem.test/api/webhooks/telegram/bot-1",
      secret_token: bot.webhookSecret,
    });
    expect((call?.body as { allowed_updates: string[] }).allowed_updates).toEqual(
      expect.arrayContaining(["message", "callback_query", "my_chat_member"]),
    );
  });

  it("connect: Telegram не принял адрес — ошибка с его пояснением", async () => {
    api.replyOnce("setWebhook", telegramError(400, "Bad Request: bad webhook: An HTTPS URL must be provided for webhook"));
    await expect(adapter.connect(bot, "http://localhost/hook")).rejects.toThrow("An HTTPS URL must be provided");
  });

  it("disconnect: наш адрес — deleteWebhook", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo(OUR_WEBHOOK));
    await adapter.disconnect(bot, OUR_WEBHOOK);
    expect(api.requests.map((request) => request.method)).toEqual(["getWebhookInfo", "deleteWebhook"]);
  });

  it("disconnect: у бота чужой адрес — deleteWebhook не вызываем", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo("https://other-service.example.com/hook"));
    await adapter.disconnect(bot, OUR_WEBHOOK);
    expect(api.callsTo("deleteWebhook")).toEqual([]);
  });

  it("disconnect: адреса уже нет — стирать нечего", async () => {
    await adapter.disconnect(bot, OUR_WEBHOOK);
    expect(api.callsTo("deleteWebhook")).toEqual([]);
  });

  it("disconnect: не удалось узнать адрес — ошибка, ничего не стёрто", async () => {
    api.replyOnce("getWebhookInfo", telegramError(500, "Internal Server Error"));
    await expect(adapter.disconnect(bot, OUR_WEBHOOK)).rejects.toThrow("Internal Server Error");
    expect(api.callsTo("deleteWebhook")).toEqual([]);
  });

  it("checkConnection: getMe отвечает — всё хорошо", async () => {
    expect(await adapter.checkConnection(bot)).toEqual({ ok: true });
    expect(api.requests).toEqual([{ method: "getMe", token: bot.token, body: {} }]);
  });

  it.each([
    [401, "Unauthorized"],
    [404, "Not Found"],
  ])("checkConnection: %i — токен отозван (invalid_token)", async (status, description) => {
    api.replyOnce("getMe", telegramError(status, description));
    expect(await adapter.checkConnection(bot)).toEqual({ ok: false, kind: "invalid_token", error: description });
  });

  it.each([
    ["прокси отдал 502 не от Telegram", { status: 502, body: "<html>Bad Gateway</html>" }, "502"],
    ["Telegram ответил 500", telegramError(500, "Internal Server Error"), "Internal Server Error"],
    ["429, слишком часто", telegramError(429, "Too Many Requests: retry after 5", { retry_after: 5 }), "Too Many Requests"],
    ["сеть упала", new Error("connect ECONNREFUSED"), "ECONNREFUSED"],
  ])("checkConnection: %s — временный сбой (temporary)", async (_name, reply, text) => {
    api.replyOnce("getMe", reply);
    const result = await adapter.checkConnection(bot);
    expect(result).toMatchObject({ ok: false, kind: "temporary" });
    expect(JSON.stringify(result)).toContain(text);
  });

  it("checkConnection: токена в тексте сбоя нет", async () => {
    api.replyOnce("getMe", new Error(`connect ECONNREFUSED https://tg-proxy.test/telegram/bot${bot.token}/getMe`));
    expect(JSON.stringify(await adapter.checkConnection(bot))).not.toContain(bot.token);
  });

  it("checkConnection: зависший запрос (таймаут) — временный сбой, а не исключение", async () => {
    const hanging = createTelegramAdapter({
      requestTimeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    expect(await hanging.checkConnection(bot)).toMatchObject({ ok: false, kind: "temporary" });
  });
});

describe("проверка вида токена", () => {
  it("настоящий вид — ошибки нет", () => {
    expect(adapter.validateTokenFormat?.("123456789:AA-secret_Token9")).toBeNull();
  });

  it.each(["", "мусор", "123456789", "abc:def", "123456789:", "123456789:с пробелом", "12:ab/../cd", ":abc"])(
    "«%s» — понятная ошибка",
    (token) => {
      expect(adapter.validateTokenFormat?.(token)).toContain("123456789:");
    },
  );
});

describe("разбор вебхука: секрет", () => {
  it("неверный секрет — rejected", async () => {
    expect(await adapter.parseWebhook(webhook(updates.plainText, "чужой"), bot)).toEqual({ kind: "rejected" });
  });

  it("секрета нет — rejected", async () => {
    expect(await adapter.parseWebhook(webhook(updates.plainText, null), bot)).toEqual({ kind: "rejected" });
  });

  it("секрет другой длины — rejected, а не ошибка", async () => {
    expect(await adapter.parseWebhook(webhook(updates.plainText, "x"), bot)).toEqual({ kind: "rejected" });
  });

  it("верный секрет, но тело не JSON — rejected", async () => {
    const request = { headers: { [TELEGRAM_SECRET_HEADER]: bot.webhookSecret }, body: "<html>" };
    expect(await adapter.parseWebhook(request, bot)).toEqual({ kind: "rejected" });
  });

  it("ответ на вебхук — пустая строка", async () => {
    const parsed = await adapter.parseWebhook(webhook(updates.plainText), bot);
    expect(parsed).toMatchObject({ kind: "events", responseBody: "" });
  });
});

describe("разбор вебхука: сообщения", () => {
  it("/start <код> — сообщение с startCode", async () => {
    expect(await eventsOf(updates.startWithCode)).toEqual([
      {
        type: "message",
        dedupeKey: "telegram:bot-1:810000001",
        userId: "5550001",
        userName: "Анна Петрова",
        text: "/start Ab3dE5gH",
        startCode: "Ab3dE5gH",
      },
    ]);
  });

  it("рекламный payload передаётся целиком из /start", async () => {
    const code = "69diuTcj__ad_campaign__video_01";
    const body = { ...updates.startWithCode, message: { ...updates.startWithCode.message, text: `/start ${code}` } };
    expect((await eventsOf(body))[0]).toMatchObject({ type: "message", startCode: code });
  });

  it("/start без кода — startCode нет", async () => {
    const [event] = await eventsOf(updates.startWithoutCode);
    expect(event).toMatchObject({ type: "message", text: "/start" });
    expect(event).not.toHaveProperty("startCode");
  });

  it("/start@имя_бота <код> — код тоже находится", async () => {
    const [event] = await eventsOf(updates.startWithCodeAndBotName);
    expect(event).toMatchObject({ type: "message", startCode: "Zz9Yy8Xx" });
  });

  it("обычный текст", async () => {
    const [event] = await eventsOf(updates.plainText);
    expect(event).toMatchObject({ type: "message", text: "Хочу научиться делать рассылки", userId: "5550001" });
    expect(event).not.toHaveProperty("startCode");
    expect(event).not.toHaveProperty("attachment");
  });

  it("имя без фамилии берётся из username, если имени нет совсем — поля userName нет", async () => {
    const onlyUsername = {
      update_id: 1,
      message: { ...updates.plainText.message, from: { id: 9, is_bot: false, first_name: "", username: "ghost" } },
    };
    expect((await eventsOf(onlyUsername))[0]).toMatchObject({ userName: "ghost" });
  });

  it.each([
    ["фото", updates.photoWithCaption, "image", "Вот мой текущий сайт"],
    ["голосовое", updates.voiceMessage, "voice", ""],
    ["стикер", updates.stickerMessage, "sticker", ""],
    ["документ", updates.documentMessage, "file", "Бриф"],
    ["геопозиция", updates.locationMessage, "other", ""],
  ] as const)("вложение: %s", async (_name, update, attachment, text) => {
    expect(await eventsOf(update)).toEqual([expect.objectContaining({ type: "message", attachment, text })]);
  });

  it("нажатие кнопки — button с id для answerCallbackQuery и данными кнопки", async () => {
    expect(await eventsOf(updates.buttonPressed)).toEqual([
      {
        type: "button",
        dedupeKey: "telegram:bot-1:810000010",
        userId: "5550001",
        callbackId: "4382901234567890123",
        payload: "menu:lead-magnet-1",
      },
    ]);
  });

  it("бот заблокирован человеком (my_chat_member: kicked) — blocked", async () => {
    expect(await eventsOf(updates.botBlockedByUser)).toEqual([
      { type: "blocked", dedupeKey: "telegram:bot-1:810000011", userId: "5550001" },
    ]);
  });

  it("человек разблокировал бота — unblocked", async () => {
    expect(await eventsOf(updates.botUnblockedByUser)).toEqual([
      { type: "unblocked", dedupeKey: "telegram:bot-1:810000012", userId: "5550001" },
    ]);
  });

  it("сообщения из групп и правки сообщений не создают событий", async () => {
    expect(await eventsOf(updates.groupMessage)).toEqual([]);
    expect(await eventsOf(updates.editedMessage)).toEqual([]);
  });

  it("ключ дедупликации: повтор того же update_id даёт тот же ключ, у другого бота — другой", async () => {
    const first = await eventsOf(updates.startWithCode);
    const repeat = await eventsOf(updates.startWithCode);
    const parsedOther = await adapter.parseWebhook(webhook(updates.startWithCode), { ...bot, id: "bot-2" });
    expect(repeat).toEqual(first);
    expect(parsedOther.kind === "events" && parsedOther.events[0]).toMatchObject({
      dedupeKey: "telegram:bot-2:810000001",
    });
  });
});

describe("отправка", () => {
  it("текст: sendMessage в HTML, номер сообщения из ответа", async () => {
    const result = await adapter.send(bot, "5550001", { text: "Привет!", idempotencyKey: "k1" });
    expect(result).toEqual({ ok: true, externalMessageId: "77" });
    expect(api.requests).toEqual([
      { method: "sendMessage", token: bot.token, body: { chat_id: "5550001", text: "Привет!", parse_mode: "HTML" } },
    ]);
  });

  it("служебные символы в тексте экранируются, ссылки остаются как есть", async () => {
    await adapter.send(bot, "5550001", { text: "Если 1 < 2 & 3 > 2, см. https://example.com/a?b=1&c=2", idempotencyKey: "k1" });
    expect(api.callsTo("sendMessage")[0]?.body).toMatchObject({
      text: "Если 1 &lt; 2 &amp; 3 &gt; 2, см. https://example.com/a?b=1&amp;c=2",
    });
  });

  it("кнопки: по одной в ряду, callback_data = payload", async () => {
    await adapter.send(bot, "5550001", {
      text: "Выберите",
      buttons: [
        { label: "Первый", payload: "menu:1" },
        { label: "Второй", payload: "menu:2" },
      ],
      idempotencyKey: "k1",
    });
    expect(api.callsTo("sendMessage")[0]?.body).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [{ text: "Первый", callback_data: "menu:1" }],
          [{ text: "Второй", callback_data: "menu:2" }],
        ],
      },
    });
  });

  it("данные кнопки длиннее 64 байт — постоянная ошибка без запроса к Telegram", async () => {
    const result = await adapter.send(bot, "5550001", {
      text: "Выберите",
      buttons: [{ label: "Длинная", payload: "я".repeat(40) }],
      idempotencyKey: "k1",
    });
    expect(result).toMatchObject({ ok: false, reason: "permanent" });
    expect(api.requests).toHaveLength(0);
  });

  it("картинка из файла с короткой подписью: один sendPhoto с загрузкой файла", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-adapter-"));
    const imagePath = join(dir, "cover.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await adapter.send(bot, "5550001", { text: "Подпись", imagePath, idempotencyKey: "k1" });

    expect(result).toEqual({ ok: true, externalMessageId: "78" });
    expect(api.requests).toHaveLength(1);
    const form = api.callsTo("sendPhoto")[0]?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("chat_id")).toBe("5550001");
    expect(form.get("caption")).toBe("Подпись");
    expect(form.get("parse_mode")).toBe("HTML");
    expect((form.get("photo") as File).name).toBe("cover.png");
  });

  it("картинка по ссылке: sendPhoto с адресом", async () => {
    await adapter.send(bot, "5550001", { text: "Подпись", imagePath: "https://cdn.test/cover.png", idempotencyKey: "k1" });
    expect(api.callsTo("sendPhoto")[0]?.body).toMatchObject({ photo: "https://cdn.test/cover.png", caption: "Подпись" });
  });

  it("подпись длиннее 1024 знаков: картинка без подписи, текст вторым сообщением", async () => {
    const longText = "а".repeat(1500);
    const result = await adapter.send(bot, "5550001", {
      text: longText,
      imagePath: "https://cdn.test/cover.png",
      idempotencyKey: "k1",
    });
    expect(api.requests.map((request) => request.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(api.callsTo("sendPhoto")[0]?.body).not.toHaveProperty("caption");
    expect(api.callsTo("sendMessage")[0]?.body).toMatchObject({ text: longText });
    expect(result).toEqual({ ok: true, externalMessageId: "77" });
  });

  it("файла картинки нет — постоянная ошибка", async () => {
    const result = await adapter.send(bot, "5550001", { text: "x", imagePath: "/no/such/file.png", idempotencyKey: "k1" });
    expect(result).toMatchObject({ ok: false, reason: "permanent" });
  });

  it("403 (человек заблокировал бота) → blocked", async () => {
    api.replyOnce("sendMessage", telegramError(403, "Forbidden: bot was blocked by the user"));
    expect(await adapter.send(bot, "5550001", { text: "x", idempotencyKey: "k1" })).toEqual({ ok: false, reason: "blocked" });
  });

  it("429 → rate_limited с паузой из retry_after", async () => {
    api.replyOnce("sendMessage", telegramError(429, "Too Many Requests: retry after 7", { retry_after: 7 }));
    expect(await adapter.send(bot, "5550001", { text: "x", idempotencyKey: "k1" })).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: 7000,
      sentParts: 0,
    });
  });

  it("429 без retry_after — пауза по умолчанию 1 секунда", async () => {
    api.replyOnce("sendMessage", telegramError(429, "Too Many Requests"));
    expect(await adapter.send(bot, "5550001", { text: "x", idempotencyKey: "k1" })).toMatchObject({
      reason: "rate_limited",
      retryAfterMs: 1000,
    });
  });

  it.each([
    [400, "Bad Request: chat not found"],
    [401, "Unauthorized"],
    [404, "Not Found"],
  ])("%i → permanent с пояснением Telegram", async (status, description) => {
    api.replyOnce("sendMessage", telegramError(status, description));
    expect(await adapter.send(bot, "5550001", { text: "x", idempotencyKey: "k1" })).toEqual({
      ok: false,
      reason: "permanent",
      error: description,
      sentParts: 0,
    });
  });

  it("5xx и ответ не от Telegram → temporary", async () => {
    api.replyOnce("sendMessage", telegramError(500, "Internal Server Error"));
    api.replyOnce("sendMessage", { status: 502, body: "<html>Bad Gateway</html>" });
    expect(await adapter.send(bot, "5550001", { text: "x", idempotencyKey: "k1" })).toMatchObject({ reason: "temporary" });
    expect(await adapter.send(bot, "5550001", { text: "x", idempotencyKey: "k1" })).toMatchObject({ reason: "temporary" });
  });

  it("сеть упала → temporary, токена в тексте ошибки нет", async () => {
    api.replyOnce("sendMessage", new Error(`fetch failed for /bot${bot.token}/sendMessage`));
    const result = await adapter.send(bot, "5550001", { text: "x", idempotencyKey: "k1" });
    expect(result).toMatchObject({ ok: false, reason: "temporary" });
    expect(JSON.stringify(result)).not.toContain(bot.token);
  });
});

describe("отправка: длинный текст, пустой текст, части", () => {
  const sentTexts = () => api.callsTo("sendMessage").map((call) => (call.body as { text: string }).text);
  const unescape = (text: string) => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const send = (text: string, extra: Partial<Parameters<typeof adapter.send>[2]> = {}) =>
    adapter.send(bot, "5550001", { text, idempotencyKey: "k1", ...extra });

  it("ровно 4096 знаков — одно сообщение", async () => {
    await send("а".repeat(4096));
    expect(sentTexts()).toEqual(["а".repeat(4096)]);
  });

  it("длиннее 4096 режется по границе абзаца", async () => {
    const result = await send(`${"а".repeat(3000)}\n\n${"б".repeat(3000)}`);
    expect(sentTexts()).toEqual(["а".repeat(3000), "б".repeat(3000)]);
    expect(result).toEqual({ ok: true, externalMessageId: "77" });
  });

  it("нет абзацев — режется по строке", async () => {
    await send(`${"а".repeat(3000)}\n${"б".repeat(3000)}`);
    expect(sentTexts()).toEqual(["а".repeat(3000), "б".repeat(3000)]);
  });

  it("нет строк — режется по пробелу, слово не рвётся", async () => {
    await send(`${"а".repeat(3000)} ${"б".repeat(3000)}`);
    expect(sentTexts()).toEqual(["а".repeat(3000), "б".repeat(3000)]);
  });

  it("нет ни пробелов, ни переносов — режется жёстко по 4096", async () => {
    await send("а".repeat(9000));
    expect(sentTexts().map((text) => text.length)).toEqual([4096, 4096, 808]);
  });

  it("абзац предпочтительнее строки, строка — пробела", async () => {
    await send(`${"а".repeat(1000)} ${"б".repeat(1000)}\n${"в".repeat(1000)}\n\n${"г".repeat(3000)}`);
    expect(sentTexts()).toEqual([`${"а".repeat(1000)} ${"б".repeat(1000)}\n${"в".repeat(1000)}`, "г".repeat(3000)]);
  });

  it("служебные знаки HTML не рвутся на границе: каждая часть сама по себе корректна и не длиннее 4096", async () => {
    const original = "Если a<b & c>d, то так. ".repeat(900);
    await send(original);
    const parts = sentTexts();
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part).not.toMatch(/&(?!amp;|lt;|gt;)/);
      expect(part).not.toMatch(/[<>]/);
      expect(unescape(part).length).toBeLessThanOrEqual(4096);
    }
    expect(unescape(parts.join("")).replace(/\s/g, "")).toBe(original.replace(/\s/g, ""));
  });

  it("эмодзи не режется посередине", async () => {
    await send("😀".repeat(3000));
    for (const part of sentTexts()) expect(part).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(sentTexts().join("")).toBe("😀".repeat(3000));
  });

  it("кнопки — только на последней части", async () => {
    await send(`${"а".repeat(3000)}\n\n${"б".repeat(3000)}`, { buttons: [{ label: "Дальше", payload: "next" }] });
    const [first, last] = api.callsTo("sendMessage");
    expect(first?.body).not.toHaveProperty("reply_markup");
    expect(last?.body).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: "Дальше", callback_data: "next" }]] } });
  });

  it("пустой текст без картинки: в Telegram ничего не уходит, результат «empty»", async () => {
    expect(await send("")).toEqual({ ok: false, reason: "empty" });
    expect(await send("  \n ")).toEqual({ ok: false, reason: "empty" });
    expect(api.requests).toEqual([]);
  });

  it("пустой текст с картинкой: уходит одна картинка без подписи", async () => {
    const result = await send("", { imagePath: "https://cdn.test/cover.png" });
    expect(result).toEqual({ ok: true, externalMessageId: "78" });
    expect(api.requests.map((request) => request.method)).toEqual(["sendPhoto"]);
    expect(api.callsTo("sendPhoto")[0]?.body).not.toHaveProperty("caption");
  });

  it("картинка и длинный текст: сбой 429 на тексте сообщает, что картинка уже ушла", async () => {
    api.replyOnce("sendPhoto", { status: 200, body: { ok: true, result: { message_id: 78 } } });
    api.replyOnce("sendMessage", telegramError(429, "Too Many Requests", { retry_after: 3 }));
    const result = await send("а".repeat(1500), { imagePath: "https://cdn.test/cover.png" });
    expect(result).toEqual({ ok: false, reason: "rate_limited", retryAfterMs: 3000, sentParts: 1 });
  });

  it("повтор с sentParts: 1 не шлёт картинку второй раз", async () => {
    const result = await send("а".repeat(1500), { imagePath: "https://cdn.test/cover.png", sentParts: 1 });
    expect(result).toEqual({ ok: true, externalMessageId: "77" });
    expect(api.requests.map((request) => request.method)).toEqual(["sendMessage"]);
  });

  it("дополнительные сообщения (ролик, прощание) уходят после основного по порядку, кнопки — на основном", async () => {
    const result = await send("Ответ", { followUps: ["▶ Ролик\nhttps://youtu.be/x", "Пока!"], buttons: [{ label: "Дальше", payload: "next" }] });
    expect(result).toMatchObject({ ok: true });
    expect(sentTexts()).toEqual(["Ответ", "▶ Ролик\nhttps://youtu.be/x", "Пока!"]);
    const [first, , last] = api.callsTo("sendMessage");
    expect(first?.body).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: "Дальше", callback_data: "next" }]] } });
        expect(last?.body).not.toHaveProperty("reply_markup");
  });

  it("сбой на дополнительном сообщении: повтор шлёт только остаток", async () => {
    api.replyOnce("sendMessage", { status: 200, body: { ok: true, result: { message_id: 1 } } });
    api.replyOnce("sendMessage", telegramError(500, "Internal Server Error"));
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
    api.replyOnce("sendMessage", { status: 200, body: { ok: true, result: { message_id: 1 } } });
    api.replyOnce("sendMessage", telegramError(500, "Internal Server Error"));
    const failed = await send(text);
    expect(failed).toMatchObject({ ok: false, reason: "temporary", sentParts: 1 });

    api.requests.length = 0;
    const retried = await send(text, { sentParts: 1 });
    expect(retried).toMatchObject({ ok: true });
    expect(sentTexts()).toEqual(["б".repeat(3000), "в".repeat(3000)]);
  });

  it("сбой на первой же части: sentParts равен нулю", async () => {
    api.replyOnce("sendMessage", telegramError(500, "Internal Server Error"));
    expect(await send("привет")).toMatchObject({ ok: false, reason: "temporary", sentParts: 0 });
  });

  it("прошлый прогресс входит в счёт: sentParts: 1, сбой на следующей части — sentParts: 1", async () => {
    const text = `${"а".repeat(3000)}\n\n${"б".repeat(3000)}`;
    api.replyOnce("sendMessage", telegramError(500, "Internal Server Error"));
    expect(await send(text, { sentParts: 1 })).toMatchObject({ ok: false, sentParts: 1 });
  });

  it("sentParts больше, чем частей (потеряли прогресс): лучше повторить последнюю часть, чем потерять", async () => {
    const result = await send("привет", { sentParts: 5 });
    expect(result).toMatchObject({ ok: true });
    expect(sentTexts()).toEqual(["привет"]);
  });
});

describe("кнопки и ссылка входа", () => {
  it("answerButton: answerCallbackQuery с id нажатия", async () => {
    await adapter.answerButton?.(bot, "4382901234567890123");
    expect(api.callsTo("answerCallbackQuery")[0]?.body).toEqual({ callback_query_id: "4382901234567890123" });
  });

  it("entryLink: t.me/<бот>?start=<код>", () => {
    expect(adapter.entryLink({ username: "live_magnet_bot", externalId: "123456789" }, "Ab3dE5gH")).toBe(
      "https://t.me/live_magnet_bot?start=Ab3dE5gH",
    );
  });

  it("kind и скорость отправки", () => {
    expect(adapter.kind).toBe("telegram");
    expect(adapter.ratePerSecond).toBeGreaterThan(0);
  });
});

describe("не занят ли бот другим сервисом (до подключения)", () => {
  const findConflict = (own: string | null = null) => adapter.findConflict!(bot.token, own);

  it("бот свободен: getWebhookInfo, затем проба getUpdates без offset — ничего не подтверждается", async () => {
    expect(await findConflict()).toBeNull();
    expect(api.requests.map((request) => request.method)).toEqual(["getWebhookInfo", "getUpdates"]);
    const probe = api.callsTo("getUpdates")[0]!.body;
    expect(probe).toEqual({ timeout: 0, limit: 1 });
    expect(probe).not.toHaveProperty("offset");
  });

  it("чужой webhook: предупреждение с одним доменом, без пути и параметров; getUpdates не зовём", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo("https://other-service.example.com/secret/path?token=abc"));
    const warning = await findConflict();
    expect(warning).toContain("Этот бот уже подключён к другому сервису (адрес: other-service.example.com)");
    expect(warning).toContain("Подключить всё равно?");
    expect(warning).not.toContain("secret");
    expect(warning).not.toContain("token=abc");
    expect(api.callsTo("getUpdates")).toEqual([]);
  });

  it("webhook пуст, а getUpdates отвечает 409 — бота читает другая программа", async () => {
    api.replyOnce("getUpdates", getUpdatesConflict());
    const warning = await findConflict();
    expect(warning).toContain("Бот сейчас занят другой программой");
    expect(warning).toContain("Подключить всё равно?");
  });

  it("новый бот: любой webhook чужой, даже похожий на наш", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo(OUR_WEBHOOK));
    expect(await findConflict(null)).toContain("livem.test");
  });

  it("наш webhook у существующего бота — не чужой, пробу не делаем", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo(OUR_WEBHOOK));
    expect(await findConflict(OUR_WEBHOOK)).toBeNull();
    expect(api.callsTo("getUpdates")).toEqual([]);
  });

  it("наш путь на другом домене (пересылка поменяла адрес) — всё равно наш", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo("https://relay.test/api/webhooks/telegram/bot-1"));
    expect(await findConflict(OUR_WEBHOOK)).toBeNull();
  });

  it("чужой webhook у существующего бота — предупреждение", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo("https://other-service.example.com/hook"));
    expect(await findConflict(OUR_WEBHOOK)).toContain("other-service.example.com");
  });

  it("не удалось спросить getWebhookInfo — ошибка, а не «свободен»", async () => {
    api.replyOnce("getWebhookInfo", telegramError(502, "Bad Gateway"));
    await expect(findConflict()).rejects.toThrow("Bad Gateway");
  });

  it("проба getUpdates упала не из-за 409 — ошибка, а не «свободен»", async () => {
    api.replyOnce("getUpdates", telegramError(500, "Internal Server Error"));
    await expect(findConflict()).rejects.toThrow("Internal Server Error");
  });
});

describe("проверка здоровья: не перехватили ли наш webhook", () => {
  it("без адреса webhook не смотрим (только getMe)", async () => {
    expect(await adapter.checkConnection(bot)).toEqual({ ok: true });
    expect(api.callsTo("getWebhookInfo")).toEqual([]);
  });

  it("наш webhook на месте — всё хорошо", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo(OUR_WEBHOOK));
    expect(await adapter.checkConnection(bot, OUR_WEBHOOK)).toEqual({ ok: true });
  });

  it("webhook заменили чужим — «бота подключили к другому сервису»", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo("https://other-service.example.com/hook"));
    expect(await adapter.checkConnection(bot, OUR_WEBHOOK)).toEqual({
      ok: false,
      kind: "taken_over",
      error: "бота подключили к другому сервису",
    });
  });

  it("webhook убрали — приём тоже потерян, статус тот же", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo(""));
    expect(await adapter.checkConnection(bot, OUR_WEBHOOK)).toMatchObject({ ok: false, kind: "taken_over" });
  });

  it("getWebhookInfo не ответил — временный сбой, бот не ломается", async () => {
    api.replyOnce("getWebhookInfo", telegramError(502, "Bad Gateway"));
    expect(await adapter.checkConnection(bot, OUR_WEBHOOK)).toMatchObject({ ok: false, kind: "temporary" });
  });

  it("токен отозван — getWebhookInfo уже не нужен", async () => {
    api.replyOnce("getMe", telegramError(401, "Unauthorized"));
    expect(await adapter.checkConnection(bot, OUR_WEBHOOK)).toMatchObject({ ok: false, kind: "invalid_token" });
    expect(api.callsTo("getWebhookInfo")).toEqual([]);
  });
});
