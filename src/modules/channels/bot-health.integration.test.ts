import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createAlerts, type AlertNotifier } from "../alerts";
import { createTokenCipher } from "../platform/crypto";
import { createFakeClock, type FakeClock } from "../platform/clock";
import type { JobEnqueuer } from "../platform/queue";
import { updateSettings } from "../platform/settings";
import {
  BOT_HEALTH_CRON,
  checkAllBots,
  reportSendFailure,
  TEMPORARY_FAILURES_BEFORE_ERROR,
  type BotHealthDependencies,
} from "./bot-health";
import type { BotCredentials, ChannelAdapters } from "./channel";
import { FakeChannel } from "./fake";
import { enqueueOutbound, requeueAfterBotRepair, sendOutbound } from "./outbound";
import { bots, outboundMessages } from "./schema";

const TEN_MINUTES = 10 * 60_000;
const cipher = createTokenCipher(Buffer.alloc(32, 7).toString("base64"));

let database: TestDatabase;
let clock: FakeClock;
let channel: FakeChannel;
let sentAlerts: Array<{ chatId: string; text: string }>;
let notifierBroken: boolean;
let deps: BotHealthDependencies;
let queuedSends: string[];

const recordingQueue: JobEnqueuer = {
  async enqueue(name, payload) {
    if (name === "outbound-send") queuedSends.push((payload as { outboundMessageId: string }).outboundMessageId);
  },
};

const notifier: AlertNotifier = {
  async send(chatId, text) {
    if (notifierBroken) throw new Error("Telegram недоступен");
    sentAlerts.push({ chatId, text });
  },
};

async function addBot(overrides: Partial<typeof bots.$inferInsert> = {}) {
  const [row] = await database.db
    .insert(bots)
    .values({
      channel: "telegram",
      title: "Живой лидмагнит",
      externalId: randomUUID(),
      username: "live_magnet_bot",
      tokenEncrypted: cipher.encrypt("fake-secret-token"),
      webhookSecret: "hook",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("Бот не создался");
  return row;
}

async function statusOf(id: string) {
  const [row] = await database.db.select().from(bots).where(eq(bots.id, id));
  if (!row) throw new Error(`Нет бота ${id}`);
  return { status: row.status, statusError: row.statusError };
}

async function failuresOf(id: string) {
  const [row] = await database.db.select({ checkFailures: bots.checkFailures }).from(bots).where(eq(bots.id, id));
  return row?.checkFailures;
}

const botAlerts = () => sentAlerts.filter((alert) => alert.text.includes("Бот"));

async function runCheck() {
  await checkAllBots(deps);
  clock.advance(TEN_MINUTES);
}

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await database.pool.query("delete from app.outbound_messages");
  await database.pool.query("delete from app.bots");
  await database.pool.query("delete from app.alerts");
  await updateSettings(database.db, { alertChatId: "alert-chat" });
  clock = createFakeClock(new Date("2026-10-10T09:00:00Z"));
  channel = new FakeChannel();
  sentAlerts = [];
  queuedSends = [];
  notifierBroken = false;
  const adapters: ChannelAdapters = { telegram: channel };
  deps = { db: database.db, queue: recordingQueue, alerts: createAlerts({ db: database.db, clock, notifier }), adapters, cipher, webhookUrl: (kind, botId) => `https://livem.test/api/webhooks/${kind}/${botId}` };
});

describe("перехват webhook", () => {
  it("бот получает адрес webhook для проверки", async () => {
    await addBot();
    const spy = vi.spyOn(channel, "checkConnection");
    await runCheck();
    const bot = (await database.db.select().from(bots))[0]!;
    expect(spy).toHaveBeenCalledWith(expect.anything(), `https://livem.test/api/webhooks/telegram/${bot.id}`);
  });

  it("webhook перехвачен: сразу «ошибка» с понятной причиной и тревога, без трёх проверок подряд", async () => {
    const bot = await addBot();
    channel.breakConnection("бота подключили к другому сервису", "taken_over");
    await runCheck();
    expect(await statusOf(bot.id)).toEqual({ status: "error", statusError: "бота подключили к другому сервису" });
    expect(botAlerts()).toHaveLength(1);
    expect(botAlerts()[0]?.text).toContain("бота подключили к другому сервису");
  });

  it("webhook вернули — бот снова «работает», тревога снята", async () => {
    const bot = await addBot();
    channel.breakConnection("бота подключили к другому сервису", "taken_over");
    await runCheck();
    channel.breakConnection(null);
    await runCheck();
    expect(await statusOf(bot.id)).toEqual({ status: "ok", statusError: null });
  });
});

describe("расписание", () => {
  it("проверка ботов идёт раз в 10 минут", () => {
    expect(BOT_HEALTH_CRON).toBe("*/10 * * * *");
  });
});

describe("проверка ботов", () => {
  it("живой бот остаётся «работает», тревог нет, адаптер получает расшифрованный токен", async () => {
    const bot = await addBot();
    const spy = vi.spyOn(channel, "checkConnection");
    await runCheck();
    expect(await statusOf(bot.id)).toEqual({ status: "ok", statusError: null });
    expect(sentAlerts).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: bot.id, token: "fake-secret-token" }), expect.any(String));
  });

  it("сбой: статус «ошибка» с причиной и одна тревога bot_error с именем бота", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized");
    await runCheck();
    expect(await statusOf(bot.id)).toEqual({ status: "error", statusError: "Unauthorized" });
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0]?.chatId).toBe("alert-chat");
    expect(sentAlerts[0]?.text).toContain("Живой лидмагнит");
    expect(sentAlerts[0]?.text).toContain("@live_magnet_bot");
    expect(sentAlerts[0]?.text).toContain("Unauthorized");
  });

  it("сбой держится несколько проверок подряд — тревога одна", async () => {
    await addBot();
    channel.breakConnection("Unauthorized");
    for (let run = 0; run < 4; run += 1) await runCheck();
    expect(botAlerts()).toHaveLength(1);
  });

  it("восстановление: статус «работает», причина очищена; новый сбой снова даёт тревогу", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized");
    await runCheck();
    channel.breakConnection(null);
    await runCheck();
    expect(await statusOf(bot.id)).toEqual({ status: "ok", statusError: null });

    channel.breakConnection("Telegram недоступен");
    await runCheck();
    expect(await statusOf(bot.id)).toEqual({ status: "error", statusError: "Telegram недоступен" });
    expect(botAlerts()).toHaveLength(2);
  });

  it("тревога не ушла (Telegram тревог недоступен) — следующая проверка пробует снова, статус при этом уже «ошибка»", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized");
    notifierBroken = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runCheck();
    expect(await statusOf(bot.id)).toMatchObject({ status: "error" });
    expect(sentAlerts).toEqual([]);

    notifierBroken = false;
    await runCheck();
    expect(botAlerts()).toHaveLength(1);
  });

  it("у каждого бота своя тревога; сбой одного не мешает проверке остальных", async () => {
    const broken = await addBot({ title: "Сломанный", username: "broken_bot" });
    const healthy = await addBot({ title: "Здоровый", username: "healthy_bot" });
    const original = channel.checkConnection.bind(channel);
    vi.spyOn(channel, "checkConnection").mockImplementation(async (bot: BotCredentials) => {
      if (bot.id === broken.id) return { ok: false, kind: "invalid_token", error: "Unauthorized" };
      return original(bot);
    });
    await runCheck();
    expect(await statusOf(broken.id)).toMatchObject({ status: "error" });
    expect(await statusOf(healthy.id)).toMatchObject({ status: "ok" });
    expect(botAlerts()).toHaveLength(1);
    expect(botAlerts()[0]?.text).toContain("Сломанный");
  });

  it("бот, токен которого не расшифровывается, — тоже «ошибка» и тревога, остальные проверяются", async () => {
    const corrupted = await addBot({ title: "Битый", tokenEncrypted: "v1:мусор" });
    const healthy = await addBot({ title: "Здоровый" });
    await runCheck();
    expect(await statusOf(corrupted.id)).toMatchObject({ status: "error" });
    expect(await statusOf(healthy.id)).toMatchObject({ status: "ok" });
    expect(botAlerts()).toHaveLength(1);
  });

  it("бот мессенджера, для которого адаптера ещё нет, пропускается без изменений", async () => {
    const vk = await addBot({ channel: "vk" });
    await runCheck();
    expect(await statusOf(vk.id)).toEqual({ status: "ok", statusError: null });
    expect(sentAlerts).toEqual([]);
  });
});

describe("временные сбои проверки (сеть, прокси)", () => {
  it("порог — три проверки подряд, то есть полчаса", () => {
    expect(TEMPORARY_FAILURES_BEFORE_ERROR).toBe(3);
  });

  it("прокси упал на одну проверку: бот остаётся «работает», тревоги нет", async () => {
    const bot = await addBot();
    channel.breakConnection("502 Bad Gateway", "temporary");
    await runCheck();
    channel.breakConnection(null);
    await runCheck();
    expect(await statusOf(bot.id)).toEqual({ status: "ok", statusError: null });
    expect(sentAlerts).toEqual([]);
  });

  it("две неудачи подряд — ещё не ошибка; успешная проверка обнуляет счёт", async () => {
    const bot = await addBot();
    channel.breakConnection("таймаут", "temporary");
    await runCheck();
    await runCheck();
    expect(await failuresOf(bot.id)).toBe(2);
    expect(await statusOf(bot.id)).toMatchObject({ status: "ok" });

    channel.breakConnection(null);
    await runCheck();
    expect(await failuresOf(bot.id)).toBe(0);

    channel.breakConnection("таймаут", "temporary");
    await runCheck();
    await runCheck();
    expect(await statusOf(bot.id)).toMatchObject({ status: "ok" });
    expect(sentAlerts).toEqual([]);
  });

  it("три неудачи подряд: статус «ошибка» с причиной и одна тревога; дальше тревога не повторяется", async () => {
    const bot = await addBot();
    channel.breakConnection("502 Bad Gateway", "temporary");
    await runCheck();
    await runCheck();
    expect(sentAlerts).toEqual([]);
    await runCheck();
    expect(await statusOf(bot.id)).toEqual({ status: "error", statusError: "502 Bad Gateway" });
    expect(botAlerts()).toHaveLength(1);
    expect(botAlerts()[0]?.text).toContain("502 Bad Gateway");
    await runCheck();
    await runCheck();
    expect(botAlerts()).toHaveLength(1);
  });

  it("после такой ошибки первая же удачная проверка возвращает «работает» и обнуляет счёт", async () => {
    const bot = await addBot();
    channel.breakConnection("таймаут", "temporary");
    for (let run = 0; run < 3; run += 1) await runCheck();
    channel.breakConnection(null);
    await runCheck();
    expect(await statusOf(bot.id)).toEqual({ status: "ok", statusError: null });
    expect(await failuresOf(bot.id)).toBe(0);
  });

  it("отозванный токен — сразу ошибка, без ожидания трёх проверок", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized", "invalid_token");
    await runCheck();
    expect(await statusOf(bot.id)).toMatchObject({ status: "error" });
    expect(botAlerts()).toHaveLength(1);
  });

  it("бот уже в ошибке из-за токена, а проверка дала временный сбой: статус и причина не затираются", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized", "invalid_token");
    await runCheck();
    channel.breakConnection("таймаут", "temporary");
    await runCheck();
    expect(await statusOf(bot.id)).toEqual({ status: "error", statusError: "Unauthorized" });
    expect(botAlerts()).toHaveLength(1);
  });
});

describe("постоянный сбой отправки в outbound-send", () => {
  const noJobs: JobEnqueuer = { async enqueue() {} };

  async function failPermanently(bot: typeof bots.$inferSelect, error: string) {
    channel.failNext({ ok: false, reason: "permanent", error });
    const { id } = await enqueueOutbound(
      { db: database.db, queue: noJobs, clock },
      { botId: bot.id, personId: randomUUID(), kind: "consultant", text: "Привет", idempotencyKey: randomUUID() },
    );
    await sendOutbound(
      {
        db: database.db,
        queue: noJobs,
        clock,
        async resolveTarget(message) {
          const credentials: BotCredentials = {
            id: bot.id,
            token: "fake-secret-token",
            externalId: bot.externalId,
            username: bot.username,
            webhookSecret: bot.webhookSecret,
          };
          return { adapter: channel, bot: credentials, to: message.personId };
        },
        async onBlocked() {},
        onPermanentFailure: (message, failure) => reportSendFailure(deps, message.botId, failure),
      },
      id,
    );
    return id;
  }

  it("неверный токен: сообщение failed, бот «ошибка», тревога bot_error", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized");
    const messageId = await failPermanently(bot, "Unauthorized");

    const [message] = await database.db.select().from(outboundMessages).where(eq(outboundMessages.id, messageId));
    expect(message?.status).toBe("failed");
    expect(await statusOf(bot.id)).toEqual({ status: "error", statusError: "Unauthorized" });
    expect(botAlerts()).toHaveLength(1);
  });

  it("много сообщений подряд с той же бедой — одна тревога, а следующая проверка раз в 10 минут её не повторяет", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized");
    await failPermanently(bot, "Unauthorized");
    await failPermanently(bot, "Unauthorized");
    await runCheck();
    expect(botAlerts()).toHaveLength(1);
  });

  it("беда одного сообщения (бот при этом жив): бот остаётся «работает», тревоги о боте нет", async () => {
    const bot = await addBot();
    await failPermanently(bot, "Bad Request: chat not found");
    expect(await statusOf(bot.id)).toEqual({ status: "ok", statusError: null });
    expect(sentAlerts).toEqual([]);
  });

  it("сообщение не ушло, а проверка бота дала временный сбой: бот остаётся «работает», сбой идёт в общий счёт", async () => {
    const bot = await addBot();
    channel.breakConnection("502 Bad Gateway", "temporary");
    await failPermanently(bot, "Internal Server Error");
    expect(await statusOf(bot.id)).toEqual({ status: "ok", statusError: null });
    expect(await failuresOf(bot.id)).toBe(1);
    expect(sentAlerts).toEqual([]);
  });

  it("бота уже нет в базе — тихо, без падения", async () => {
    await expect(reportSendFailure(deps, randomUUID(), "Unauthorized")).resolves.toBe("message");
    expect(sentAlerts).toEqual([]);
  });

  it("после починки токена проверка раз в 10 минут возвращает «работает» и снимает тревогу", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized");
    await failPermanently(bot, "Unauthorized");
    channel.breakConnection(null);
    await runCheck();
    expect(await statusOf(bot.id)).toEqual({ status: "ok", statusError: null });
  });
});

describe("сообщения, упавшие из-за бота, после его починки", () => {
  const noJobs: JobEnqueuer = { async enqueue() {} };

  async function sendFailing(bot: typeof bots.$inferSelect, error: string, key = randomUUID()) {
    channel.failNext({ ok: false, reason: "permanent", error });
    const { id } = await enqueueOutbound(
      { db: database.db, queue: noJobs, clock },
      { botId: bot.id, personId: randomUUID(), kind: "consultant", text: "Привет", idempotencyKey: key },
    );
    await sendOutbound(senderFor(bot), id);
    return id;
  }

  function senderFor(bot: typeof bots.$inferSelect) {
    return {
      db: database.db,
      queue: noJobs,
      clock,
      async resolveTarget(message: typeof outboundMessages.$inferSelect) {
        const credentials: BotCredentials = {
          id: bot.id,
          token: "fake-secret-token",
          externalId: bot.externalId,
          username: bot.username,
          webhookSecret: bot.webhookSecret,
        };
        return { adapter: channel, bot: credentials, to: message.personId };
      },
      async onBlocked() {},
      onPermanentFailure: (message: typeof outboundMessages.$inferSelect, failure: string) =>
        reportSendFailure(deps, message.botId, failure),
    };
  }

  async function messageOf(id: string) {
    const [row] = await database.db.select().from(outboundMessages).where(eq(outboundMessages.id, id));
    if (!row) throw new Error(`Нет сообщения ${id}`);
    return row;
  }

  it("токен отозван: сообщение помечено «ждёт починки бота»", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized");
    const id = await sendFailing(bot, "Unauthorized");
    expect(await messageOf(id)).toMatchObject({ status: "failed", awaitsBotRepair: true });
  });

  it("проверка вернула бота в «работает»: сообщение снова в очереди с тем же ключом и уходит один раз", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized");
    const key = randomUUID();
    const id = await sendFailing(bot, "Unauthorized", key);
    channel.breakConnection(null);
    await runCheck();

    expect(await messageOf(id)).toMatchObject({
      status: "queued",
      attempts: 0,
      error: null,
      awaitsBotRepair: false,
      idempotencyKey: key,
    });
    expect(queuedSends).toEqual([id]);

    await sendOutbound(senderFor(bot), id);
    await sendOutbound(senderFor(bot), id);
    expect((await messageOf(id)).status).toBe("sent");
    expect(channel.sent.filter((sent) => sent.message.idempotencyKey === key)).toHaveLength(1);

    // Следующая проверка второй раз ничего не ставит
    await runCheck();
    expect(queuedSends).toEqual([id]);
  });

  it("пока бот сломан, проверка сообщения не возвращает", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized");
    const id = await sendFailing(bot, "Unauthorized");
    await runCheck();
    expect(await messageOf(id)).toMatchObject({ status: "failed", awaitsBotRepair: true });
    expect(queuedSends).toEqual([]);
  });

  it("сообщение старше 3 суток не возвращается", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized");
    const old = await sendFailing(bot, "Unauthorized");
    const fresh = await sendFailing(bot, "Unauthorized");
    await database.pool.query(
      "update app.outbound_messages set created_at = now() - interval '3 days 1 minute' where id = $1",
      [old],
    );
    channel.breakConnection(null);
    await runCheck();
    expect((await messageOf(old)).status).toBe("failed");
    expect((await messageOf(fresh)).status).toBe("queued");
    expect(queuedSends).toEqual([fresh]);
  });

  it("сообщение, не ушедшее по своей причине (бот жив), не возвращается", async () => {
    const bot = await addBot();
    const id = await sendFailing(bot, "Bad Request: chat not found");
    await runCheck();
    expect(await messageOf(id)).toMatchObject({ status: "failed", awaitsBotRepair: false });
    expect(queuedSends).toEqual([]);
  });

  it("сообщение, помеченное «ждёт починки» во время возврата, не теряет пометку", async () => {
    const bot = await addBot();
    channel.breakConnection("Unauthorized");
    const locked = await sendFailing(bot, "Unauthorized");
    const late = await sendFailing(bot, "Unauthorized");
    // `late` упало, но пометку получит, когда возврат уже идёт
    await database.pool.query("update app.outbound_messages set awaits_bot_repair = false where id = $1", [late]);

    const blocker = await database.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select 1 from app.outbound_messages where id = $1 for update", [locked]);
      const requeue = requeueAfterBotRepair({ db: database.db, queue: recordingQueue }, bot.id);
      await waitForLockWait();
      await database.pool.query("update app.outbound_messages set awaits_bot_repair = true where id = $1", [late]);
      await blocker.query("commit");
      await requeue;
    } finally {
      blocker.release();
    }

    expect(await messageOf(locked)).toMatchObject({ status: "queued", awaitsBotRepair: false });
    expect(await messageOf(late)).toMatchObject({ status: "failed", awaitsBotRepair: true });
    expect(queuedSends).toEqual([locked]);
  });

  it("возвращаются только сообщения починенного бота", async () => {
    const broken = await addBot();
    const other = await addBot();
    channel.breakConnection("Unauthorized");
    const ofBroken = await sendFailing(broken, "Unauthorized");
    const ofOther = await sendFailing(other, "Unauthorized");
    // Чинится только первый: второй в проверке снова получает отказ
    channel.breakConnection(null);
    vi.spyOn(channel, "checkConnection").mockImplementation(async (credentials) =>
      credentials.id === other.id ? { ok: false, kind: "invalid_token", error: "Unauthorized" } : { ok: true },
    );
    await runCheck();
    expect((await messageOf(ofBroken)).status).toBe("queued");
    expect((await messageOf(ofOther)).status).toBe("failed");
  });
});

/** Ждёт, пока какой-то запрос этой базы встанет в очередь за блокировкой строки. */
async function waitForLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await database.pool.query<{ waiting: number }>(
      "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if (rows[0]!.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Запрос так и не встал за блокировкой");
}
