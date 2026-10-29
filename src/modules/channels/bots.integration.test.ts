import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertService } from "../alerts";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createTokenCipher } from "../platform/crypto";
import type { JobEnqueuer } from "../platform/queue";
import { createBotService, type BotService } from "./bots";
import { FakeChannel } from "./fake";
import { createTelegramAdapter } from "./telegram/adapter";
import { FakeTelegramApi, getUpdatesConflict, telegramError, webhookInfo } from "./telegram/fake-telegram-api";
import { bots, outboundMessages } from "./schema";

const cipher = createTokenCipher(Buffer.alloc(32, 3).toString("base64"));
const PUBLIC_BASE_URL = "https://livem.test";

let database: TestDatabase;
let channel: FakeChannel;
let service: BotService;
let alerts: AlertService;
let queuedSends: string[];

const queue: JobEnqueuer = {
  async enqueue(name, payload) {
    if (name === "outbound-send") queuedSends.push((payload as { outboundMessageId: string }).outboundMessageId);
  },
};

function serviceWith(overrides: { publicBaseUrl?: string; telegramWebhookBaseUrl?: string } = {}) {
  return createBotService({
    db: database.db,
    adapters: { telegram: channel },
    cipher,
    alerts,
    queue,
    publicBaseUrl: overrides.publicBaseUrl ?? PUBLIC_BASE_URL,
    telegramWebhookBaseUrl: overrides.telegramWebhookBaseUrl,
  });
}

const allBots = () => database.db.select().from(bots);

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("delete from app.bots");
  await database.pool.query("delete from app.outbound_messages");
  queuedSends = [];
  channel = new FakeChannel();
  alerts = { raise: vi.fn(), acknowledge: vi.fn(), resolve: vi.fn() };
  service = serviceWith();
});

describe("подключение бота", () => {
  it("проверяет токен, настраивает приём, сохраняет имя и статус «работает»", async () => {
    const result = await service.connectBot({ channel: "telegram", token: "fake-alpha" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bot).toMatchObject({
      channel: "telegram",
      title: "Бот alpha",
      username: "bot_alpha",
      status: "ok",
      statusError: null,
    });
    expect(channel.connectedWebhooks.get(result.bot.id)).toBe(`${PUBLIC_BASE_URL}/api/webhooks/telegram/${result.bot.id}`);

    const [row] = await allBots();
    expect(row).toMatchObject({ id: result.bot.id, externalId: "ext-fake-alpha", noCodeMode: "nothing", defaultLeadMagnetId: null });
  });

  it("токен в базе только зашифрованный и расшифровывается обратно", async () => {
    await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    const [row] = await allBots();
    expect(row?.tokenEncrypted).not.toContain("fake-alpha");
    expect(cipher.decrypt(row?.tokenEncrypted ?? "")).toBe("fake-alpha");
  });

  it("у каждого бота свой секрет вебхука, пригодный для заголовка Telegram", async () => {
    await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    await service.connectBot({ channel: "telegram", token: "fake-beta" });
    const secrets = (await allBots()).map((row) => row.webhookSecret);
    expect(new Set(secrets).size).toBe(2);
    for (const secret of secrets) expect(secret).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
  });

  it("секрет, отданный мессенджеру, совпадает с сохранённым", async () => {
    const seen: string[] = [];
    const original = channel.connect.bind(channel);
    channel.connect = async (bot, url) => {
      seen.push(bot.webhookSecret);
      return original(bot, url);
    };
    await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    expect(seen).toEqual([(await allBots())[0]?.webhookSecret]);
  });

  it("лишние пробелы и перевод строки при вставке токена не мешают", async () => {
    const result = await service.connectBot({ channel: "telegram", token: "  fake-alpha \n" });
    expect(result.ok).toBe(true);
    expect(cipher.decrypt((await allBots())[0]?.tokenEncrypted ?? "")).toBe("fake-alpha");
  });

  it("адрес приложения с косой чертой на конце не даёт двойной косой", async () => {
    const result = await serviceWith({ publicBaseUrl: "https://livem.test/" }).connectBot({ channel: "telegram", token: "fake-alpha" });
    if (!result.ok) throw new Error(result.error);
    expect(channel.connectedWebhooks.get(result.bot.id)).toBe(`https://livem.test/api/webhooks/telegram/${result.bot.id}`);
  });

  it("отдельный адрес для вебхуков Telegram (пересылка через прокси) главнее адреса приложения", async () => {
    const result = await serviceWith({ telegramWebhookBaseUrl: "https://relay.test/livem/" }).connectBot({
      channel: "telegram",
      token: "fake-alpha",
    });
    if (!result.ok) throw new Error(result.error);
    expect(channel.connectedWebhooks.get(result.bot.id)).toBe(`https://relay.test/livem/api/webhooks/telegram/${result.bot.id}`);
  });

  it("неверный токен: понятная ошибка, ничего не сохранено, приём не настраивался", async () => {
    const result = await service.connectBot({ channel: "telegram", token: "мусор" });
    expect(result).toEqual({ ok: false, error: "Неверный токен бота" });
    expect(await allBots()).toEqual([]);
    expect(channel.connectedWebhooks.size).toBe(0);
  });

  it("пустой токен: подсказка вставить токен", async () => {
    expect(await service.connectBot({ channel: "telegram", token: "   " })).toEqual({
      ok: false,
      error: "Вставьте токен бота",
    });
  });

  it("публичный адрес приложения не задан: понятная ошибка, мессенджер не трогаем", async () => {
    const result = await serviceWith({ publicBaseUrl: "" }).connectBot({ channel: "telegram", token: "fake-alpha" });
    expect(result).toEqual({ ok: false, error: "Не задан публичный адрес приложения (PUBLIC_BASE_URL)" });
    expect(await allBots()).toEqual([]);
  });

  it("мессенджер не принял адрес приёма: ошибка с причиной, бот не сохраняется", async () => {
    channel.connect = async () => {
      throw new Error("Bad Request: bad webhook: An HTTPS URL must be provided for webhook");
    };
    const result = await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("An HTTPS URL must be provided");
    expect(await allBots()).toEqual([]);
  });

  it("исправный бот второй раз не подключается", async () => {
    await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    const second = await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    expect(second).toEqual({ ok: false, error: "Этот бот уже подключён" });
    expect(await allBots()).toHaveLength(1);
    expect(channel.connectedWebhooks.size).toBe(1);
  });

  it("два одновременных подключения одного бота: одно проходит, второе получает «уже подключён»", async () => {
    const results = await Promise.all([
      service.connectBot({ channel: "telegram", token: "fake-alpha" }),
      service.connectBot({ channel: "telegram", token: "fake-alpha" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, error: "Этот бот уже подключён" });
    expect(await allBots()).toHaveLength(1);
  });

  it("бот с ошибкой (токен отозвали) подключается заново с новым токеном: та же запись, статус «работает», тревога снята", async () => {
    const first = await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    if (!first.ok) throw new Error(first.error);
    const [before] = await allBots();
    await database.db.update(bots).set({ status: "error", statusError: "Unauthorized" }).where(eq(bots.id, first.bot.id));
    channel.verifyToken = async () => ({ externalId: "ext-fake-alpha", username: "bot_alpha", title: "Бот alpha (новое имя)" });

    const again = await service.connectBot({ channel: "telegram", token: "fake-alpha-new" });

    expect(again.ok && again.bot.id).toBe(first.bot.id);
    const rows = await allBots();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "ok", statusError: null, title: "Бот alpha (новое имя)", webhookSecret: before?.webhookSecret });
    expect(cipher.decrypt(rows[0]?.tokenEncrypted ?? "")).toBe("fake-alpha-new");
    expect(channel.connectedWebhooks.get(first.bot.id)).toBe(`${PUBLIC_BASE_URL}/api/webhooks/telegram/${first.bot.id}`);
    expect(alerts.resolve).toHaveBeenCalledWith("bot_error", first.bot.id);
  });

  it("бот подключён заново: сообщения, упавшие из-за него, снова в очереди с тем же ключом", async () => {
    const first = await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    if (!first.ok) throw new Error(first.error);
    await database.db.update(bots).set({ status: "error", statusError: "Unauthorized" }).where(eq(bots.id, first.bot.id));
    const [waiting] = await database.db
      .insert(outboundMessages)
      .values({
        botId: first.bot.id,
        personId: randomUUID(),
        kind: "consultant",
        text: "Ответ",
        idempotencyKey: "turn:waiting",
        status: "failed",
        error: "Unauthorized",
        awaitsBotRepair: true,
      })
      .returning();
    if (!waiting) throw new Error("Сообщение не создалось");
    channel.verifyToken = async () => ({ externalId: "ext-fake-alpha", username: "bot_alpha", title: "Бот alpha" });

    const again = await service.connectBot({ channel: "telegram", token: "fake-alpha-new" });

    expect(again.ok).toBe(true);
    const [row] = await database.db.select().from(outboundMessages).where(eq(outboundMessages.id, waiting.id));
    expect(row).toMatchObject({ status: "queued", awaitsBotRepair: false, idempotencyKey: "turn:waiting" });
    expect(queuedSends).toEqual([waiting.id]);
  });

  it("повторное подключение не удалось — старые данные бота не тронуты", async () => {
    const first = await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    if (!first.ok) throw new Error(first.error);
    await database.db.update(bots).set({ status: "error", statusError: "Unauthorized" }).where(eq(bots.id, first.bot.id));
    channel.verifyToken = async () => ({ externalId: "ext-fake-alpha", username: "bot_alpha", title: "Бот alpha" });
    channel.connect = async () => {
      throw new Error("Telegram недоступен");
    };

    const again = await service.connectBot({ channel: "telegram", token: "fake-alpha-new" });

    expect(again.ok).toBe(false);
    const [row] = await allBots();
    expect(row).toMatchObject({ status: "error", statusError: "Unauthorized" });
    expect(cipher.decrypt(row?.tokenEncrypted ?? "")).toBe("fake-alpha");
    expect(alerts.resolve).not.toHaveBeenCalled();
  });

  it("мессенджер без адаптера: честное сообщение", async () => {
    const result = await service.connectBot({ channel: "vk", token: "fake-alpha" });
    expect(result).toEqual({ ok: false, error: "Подключение этого мессенджера ещё не готово" });
  });
});

describe("проверка вида токена Telegram", () => {
  let api: FakeTelegramApi;
  let telegramService: BotService;

  beforeEach(() => {
    api = new FakeTelegramApi();
    telegramService = createBotService({
      db: database.db,
      adapters: { telegram: createTelegramAdapter({ fetch: api.fetch }) },
      cipher,
      alerts,
      queue,
      publicBaseUrl: PUBLIC_BASE_URL,
    });
  });

  it.each(["мусор", "123456789", "abc:def", "123456789:", "123456789:с пробелом", "12:ab/../cd"])(
    "«%s»: понятная ошибка в форме, к Telegram не обращались, в базе пусто",
    async (token) => {
      const result = await telegramService.connectBot({ channel: "telegram", token });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain("123456789:");
      expect(api.requests).toEqual([]);
      expect(await allBots()).toEqual([]);
    },
  );

  it("токен верного вида проходит дальше: getMe, setWebhook, бот сохранён", async () => {
    const result = await telegramService.connectBot({ channel: "telegram", token: " 123456789:AA-secret_Token9\n" });
    expect(result.ok).toBe(true);
    expect(api.requests.map((request) => request.method)).toEqual(["getMe", "getWebhookInfo", "getUpdates", "setWebhook"]);
    expect(api.requests[0]?.token).toBe("123456789:AA-secret_Token9");
  });

  it("верный вид, но Telegram не знает токен — «Неверный токен бота»", async () => {
    api.replyOnce("getMe", telegramError(401, "Unauthorized"));
    const result = await telegramService.connectBot({ channel: "telegram", token: "123456789:AA-secret_Token9" });
    expect(!result.ok && result.error).toContain("Неверный токен бота");
  });
});

const BUSY = "Бот сейчас занят другой программой. Если подключить его здесь, она перестанет получать сообщения. Подключить всё равно?";

describe("бот занят другим сервисом", () => {
  it("новый бот: предупреждение, ничего не сохранено и не настроено", async () => {
    channel.occupy(BUSY);
    const result = await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    expect(result).toEqual({ ok: false, error: BUSY, needsConfirmation: true });
    expect(await allBots()).toEqual([]);
    expect(channel.connectedWebhooks.size).toBe(0);
    expect(channel.conflictChecks).toEqual([{ token: "fake-alpha", ownWebhookUrl: null }]);
  });

  it("«Подключить всё равно»: проверка пропущена, бот подключён", async () => {
    channel.occupy(BUSY);
    const result = await service.connectBot({ channel: "telegram", token: "fake-alpha", force: true });
    expect(result.ok).toBe(true);
    expect(channel.conflictChecks).toEqual([]);
    expect(await allBots()).toHaveLength(1);
    expect(channel.connectedWebhooks.size).toBe(1);
  });

  it("повторное подключение бота с ошибкой: проверка с нашим адресом, при конфликте ничего не меняется", async () => {
    const first = await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    if (!first.ok) throw new Error(first.error);
    await database.db.update(bots).set({ status: "error", statusError: "Unauthorized" }).where(eq(bots.id, first.bot.id));
    channel.connectedWebhooks.clear();
    channel.conflictChecks.length = 0;
    channel.occupy(BUSY);

    const again = await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    expect(again).toEqual({ ok: false, error: BUSY, needsConfirmation: true });
    expect(channel.conflictChecks).toEqual([
      { token: "fake-alpha", ownWebhookUrl: `${PUBLIC_BASE_URL}/api/webhooks/telegram/${first.bot.id}` },
    ]);
    expect(channel.connectedWebhooks.size).toBe(0);
    expect((await allBots())[0]).toMatchObject({ status: "error", statusError: "Unauthorized" });

    const forced = await service.connectBot({ channel: "telegram", token: "fake-alpha", force: true });
    expect(forced.ok).toBe(true);
    expect((await allBots())[0]).toMatchObject({ status: "ok", statusError: null });
  });

  it("свободный бот подключается без вопросов", async () => {
    const result = await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    expect(result.ok).toBe(true);
    expect(channel.conflictChecks).toHaveLength(1);
  });
});

describe("Telegram: подключение и отключение чужого бота", () => {
  let api: FakeTelegramApi;
  let telegramService: BotService;
  const TOKEN = "123456789:AA-secret_Token9";

  beforeEach(() => {
    api = new FakeTelegramApi();
    telegramService = createBotService({
      db: database.db,
      adapters: { telegram: createTelegramAdapter({ fetch: api.fetch }) },
      cipher,
      alerts,
      queue,
      publicBaseUrl: PUBLIC_BASE_URL,
    });
  });

  it("чужой webhook: предупреждение с доменом, setWebhook не вызван, в базе пусто", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo("https://other-service.example.com/hook"));
    const result = await telegramService.connectBot({ channel: "telegram", token: TOKEN });
    expect(result).toMatchObject({ ok: false, needsConfirmation: true });
    expect(!result.ok && result.error).toContain("other-service.example.com");
    expect(api.callsTo("setWebhook")).toEqual([]);
    expect(await allBots()).toEqual([]);
  });

  it("getUpdates отвечает 409: предупреждение «занят другой программой», setWebhook не вызван", async () => {
    api.replyOnce("getUpdates", getUpdatesConflict());
    const result = await telegramService.connectBot({ channel: "telegram", token: TOKEN });
    expect(result).toMatchObject({ ok: false, needsConfirmation: true });
    expect(!result.ok && result.error).toContain("Бот сейчас занят другой программой");
    expect(api.callsTo("setWebhook")).toEqual([]);
  });

  it("«Подключить всё равно»: проверок нет, сразу setWebhook", async () => {
    api.replyOnce("getWebhookInfo", webhookInfo("https://other-service.example.com/hook"));
    const result = await telegramService.connectBot({ channel: "telegram", token: TOKEN, force: true });
    expect(result.ok).toBe(true);
    expect(api.requests.map((request) => request.method)).toEqual(["getMe", "setWebhook"]);
  });

  it("не удалось проверить занятость — подключения нет, причина в ошибке", async () => {
    api.replyOnce("getWebhookInfo", telegramError(502, "Bad Gateway"));
    const result = await telegramService.connectBot({ channel: "telegram", token: TOKEN });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.needsConfirmation).toBeFalsy();
    expect(!result.ok && result.error).toContain("Bad Gateway");
    expect(api.callsTo("setWebhook")).toEqual([]);
    expect(await allBots()).toEqual([]);
  });

  async function connected() {
    const result = await telegramService.connectBot({ channel: "telegram", token: TOKEN });
    if (!result.ok) throw new Error(result.error);
    api.requests.length = 0;
    return result.bot;
  }

  it("удаление бота: наш адрес стирается", async () => {
    const bot = await connected();
    api.replyOnce("getWebhookInfo", webhookInfo(`${PUBLIC_BASE_URL}/api/webhooks/telegram/${bot.id}`));
    expect(await telegramService.deleteBot(bot.id)).toEqual({ ok: true });
    expect(api.callsTo("deleteWebhook")).toHaveLength(1);
  });

  it("удаление бота: адрес уже чужой — deleteWebhook не вызывается", async () => {
    const bot = await connected();
    api.replyOnce("getWebhookInfo", webhookInfo("https://other-service.example.com/hook"));
    expect(await telegramService.deleteBot(bot.id)).toEqual({ ok: true });
    expect(api.callsTo("deleteWebhook")).toEqual([]);
  });

  it("повторное подключение: чужой адрес — предупреждение, наш — setWebhook без вопросов", async () => {
    const bot = await connected();
    await database.db.update(bots).set({ status: "error", statusError: "x" }).where(eq(bots.id, bot.id));

    api.replyOnce("getWebhookInfo", webhookInfo("https://other-service.example.com/hook"));
    expect(await telegramService.connectBot({ channel: "telegram", token: TOKEN })).toMatchObject({ ok: false, needsConfirmation: true });
    expect(api.callsTo("setWebhook")).toEqual([]);

    api.replyOnce("getWebhookInfo", webhookInfo(`${PUBLIC_BASE_URL}/api/webhooks/telegram/${bot.id}`));
    expect((await telegramService.connectBot({ channel: "telegram", token: TOKEN })).ok).toBe(true);
    expect(api.callsTo("setWebhook")).toHaveLength(1);
  });
});

describe("список ботов и данные для отправки", () => {
  it("список без токенов, старые сверху", async () => {
    await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    await service.connectBot({ channel: "telegram", token: "fake-beta" });
    const list = await service.listBots();
    expect(list.map((bot) => bot.username)).toEqual(["bot_alpha", "bot_beta"]);
    expect(JSON.stringify(list)).not.toContain("fake-alpha");
    expect(list[0]).not.toHaveProperty("tokenEncrypted");
    expect(list[0]).not.toHaveProperty("webhookSecret");
  });

  it("список показывает статус ошибки и её причину", async () => {
    const result = await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    if (!result.ok) throw new Error(result.error);
    await database.db.update(bots).set({ status: "error", statusError: "Unauthorized" }).where(eq(bots.id, result.bot.id));
    expect((await service.listBots())[0]).toMatchObject({ status: "error", statusError: "Unauthorized" });
  });

  it("loadBotCredentials отдаёт бота с расшифрованным токеном и секретом", async () => {
    const result = await service.connectBot({ channel: "telegram", token: "fake-alpha" });
    if (!result.ok) throw new Error(result.error);
    expect(await service.loadBotCredentials(result.bot.id)).toEqual({
      id: result.bot.id,
      token: "fake-alpha",
      externalId: "ext-fake-alpha",
      username: "bot_alpha",
      webhookSecret: (await allBots())[0]?.webhookSecret,
    });
  });

  it("loadBotCredentials: бота нет — null", async () => {
    expect(await service.loadBotCredentials("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
