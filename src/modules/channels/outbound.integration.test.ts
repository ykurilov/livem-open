import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { passages } from "../conversations/schema";
import { createLeadMagnet, saveDraft } from "../lead-magnets";
import { people } from "../people/schema";
import { createFakeClock, type FakeClock } from "../platform/clock";
import type { EnqueueOptions, JobEnqueuer, JobName, JobPayloads } from "../platform/queue";
import type { BotCredentials } from "./channel";
import { FakeChannel } from "./fake";
import { createRateLimiter, type RateLimiter } from "./rate-limiter";
import { enqueueOutbound, sendOutbound, type OutboundDependencies, type SendTarget } from "./outbound";
import { bots, outboundMessages } from "./schema";

interface EnqueuedJob {
  name: JobName;
  payload: JobPayloads[JobName];
  options?: EnqueueOptions;
}

let database: TestDatabase;
let clock: FakeClock;
let channel: FakeChannel;
let jobs: EnqueuedJob[];
let blocked: string[];
let failures: Array<{ id: string; error: string }>;
let sleeps: number[];
let enqueueShouldFail: boolean;
let rateLimiter: RateLimiter;

const bot: BotCredentials = {
  id: randomUUID(),
  token: "fake-token",
  externalId: "ext-1",
  username: "test_bot",
  webhookSecret: "secret",
};
const personId = randomUUID();
const TELEGRAM_USER = "tg-100";

const queue: JobEnqueuer = {
  async enqueue(name, payload, options) {
    if (enqueueShouldFail) throw new Error("очередь недоступна");
    jobs.push({ name, payload, options });
  },
};

function dependencies(overrides: Partial<OutboundDependencies> = {}): OutboundDependencies {
  return {
    db: database.db,
    queue,
    clock,
    rateLimiter,
    async resolveTarget(): Promise<SendTarget> {
      return { adapter: channel, bot, to: TELEGRAM_USER };
    },
    async onBlocked(message) {
      blocked.push(message.id);
    },
    async onPermanentFailure(message, error) {
      failures.push({ id: message.id, error });
      return "message";
    },
    ...overrides,
  };
}

const draft = (key = randomUUID()) => ({
  botId: bot.id,
  personId,
  kind: "consultant" as const,
  text: "Привет!",
  idempotencyKey: key,
});

async function rowOf(id: string) {
  const [row] = await database.db.select().from(outboundMessages).where(eq(outboundMessages.id, id));
  if (!row) throw new Error(`Нет сообщения ${id}`);
  return row;
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
  clock = createFakeClock(new Date("2026-10-10T09:00:00Z"));
  channel = new FakeChannel({ ratePerSecond: 2 });
  jobs = [];
  blocked = [];
  failures = [];
  sleeps = [];
  enqueueShouldFail = false;
  rateLimiter = createRateLimiter({
    now: () => clock.now().getTime(),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
});

/** Идущее прохождение в ВК: отказ «окно ответа закрыто» его не заканчивает. */
async function seedVkPassage(): Promise<{ passageId: string; personId: string; botId: string }> {
  const tag = randomUUID().slice(0, 8);
  const [vkBot] = await database.db
    .insert(bots)
    .values({ channel: "vk", title: `Бот ${tag}`, externalId: tag, username: `bot_${tag}`, tokenEncrypted: "x", webhookSecret: tag })
    .returning();
  const [person] = await database.db
    .insert(people)
    .values({ channel: "vk", botId: vkBot!.id, externalUserId: tag, displayName: "Анна" })
    .returning();
  const lead = await createLeadMagnet(database.db, { name: `Лид ${tag}` });
  const version = await saveDraft(database.db, lead.id, { ...lead.draft, name: `Лид ${tag}` }, "manual");
  const [passage] = await database.db
    .insert(passages)
    .values({
      personId: person!.id,
      leadMagnetId: lead.id,
      snapshotId: version.id,
      chatId: `chat-${tag}`,
    })
    .returning();
  return { passageId: passage!.id, personId: person!.id, botId: vkBot!.id };
}

describe("постановка в очередь исходящих", () => {
  it("записывает сообщение и ставит задачу отправки", async () => {
    const result = await enqueueOutbound(dependencies(), draft());
    expect(result.created).toBe(true);
    expect((await rowOf(result.id)).status).toBe("queued");
    expect(jobs).toEqual([{ name: "outbound-send", payload: { outboundMessageId: result.id }, options: undefined }]);
  });

  it("то же сообщение с тем же ключом во второй раз не создаётся и задачу не ставит", async () => {
    const key = randomUUID();
    const first = await enqueueOutbound(dependencies(), draft(key));
    const second = await enqueueOutbound(dependencies(), draft(key));
    expect(second).toEqual({ id: first.id, created: false });
    expect(jobs).toHaveLength(1);
    expect((await database.pool.query("select count(*)::int as n from app.outbound_messages")).rows[0].n).toBe(1);
  });

  it("если очередь не приняла задачу, запись откатывается и ошибка не глотается", async () => {
    enqueueShouldFail = true;
    const key = randomUUID();
    await expect(enqueueOutbound(dependencies(), draft(key))).rejects.toThrow("очередь недоступна");
    expect((await database.pool.query("select count(*)::int as n from app.outbound_messages")).rows[0].n).toBe(0);
    enqueueShouldFail = false;
    expect((await enqueueOutbound(dependencies(), draft(key))).created).toBe(true);
  });

  it("можно отложить отправку", async () => {
    const { id } = await enqueueOutbound(dependencies(), { ...draft(), delaySeconds: 30 });
    expect(jobs[0]?.options).toEqual({ delaySeconds: 30 });
    // Срок попытки записан: по нему подмётчик отличает отложенное от потерянного
    expect((await rowOf(id)).nextAttemptAt).toEqual(new Date(clock.now().getTime() + 30_000));
  });
});

describe("отправка", () => {
  it("успех: статус sent, номер сообщения в мессенджере, время отправки", async () => {
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), id);
    const row = await rowOf(id);
    expect(row.status).toBe("sent");
    expect(row.externalMessageId).toBe("fake-1");
    expect(row.sentAt).toEqual(clock.now());
    expect(channel.messagesTo(TELEGRAM_USER)).toHaveLength(1);
    expect(channel.sent[0]?.message).toMatchObject({ text: "Привет!", idempotencyKey: row.idempotencyKey });
  });

  it("повторный запуск той же задачи ничего не отправляет второй раз", async () => {
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), id);
    await sendOutbound(dependencies(), id);
    expect(channel.attempts).toHaveLength(1);
  });

  it("две одновременные задачи на одно сообщение отправляют его один раз", async () => {
    const { id } = await enqueueOutbound(dependencies(), draft());
    await Promise.all([sendOutbound(dependencies(), id), sendOutbound(dependencies(), id)]);
    expect(channel.attempts).toHaveLength(1);
  });

  it("между сообщениями одного бота выдерживается пауза по ratePerSecond", async () => {
    const first = await enqueueOutbound(dependencies(), draft());
    const second = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), first.id);
    await sendOutbound(dependencies(), second.id);
    expect(sleeps).toEqual([500]);
  });

  it("блокировка: статус blocked, эксперту сообщается, повторов нет", async () => {
    channel.blockUser(TELEGRAM_USER);
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), id);
    expect((await rowOf(id)).status).toBe("blocked");
    expect(blocked).toEqual([id]);
    expect(jobs).toHaveLength(1); // только первоначальная постановка
  });

  it("окно ответа закрыто (ВК 950): сообщение не ушло; не блокировка, не тревога, не повтор, разговор идёт", async () => {
    const world = await seedVkPassage();
    channel.failNext({ ok: false, reason: "reply_window_closed" });
    const { id } = await enqueueOutbound(dependencies(), {
      ...draft(),
      botId: world.botId,
      personId: world.personId,
      passageId: world.passageId,
      kind: "consultant",
    });
    await sendOutbound(dependencies(), id);

    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(row.awaitsBotRepair).toBe(false);
    expect(blocked).toEqual([]);
    expect(failures).toEqual([]);
    expect(jobs).toHaveLength(1); // только первоначальная постановка

    const [passage] = await database.db.select().from(passages).where(eq(passages.id, world.passageId));
    expect(passage).toMatchObject({ status: "active" });
  });

  it("окно ответа закрыто у сообщения без прохождения: ничего не падает, блокировки нет", async () => {
    channel.failNext({ ok: false, reason: "reply_window_closed" });
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), id);
    expect((await rowOf(id)).status).toBe("failed");
    expect(blocked).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("rate_limited: ждём указанное время, попытки не тратятся", async () => {
    channel.failNext({ ok: false, reason: "rate_limited", retryAfterMs: 2500 });
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), id);
    const row = await rowOf(id);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(jobs.at(-1)).toEqual({
      name: "outbound-send",
      payload: { outboundMessageId: id },
      options: { delaySeconds: 3 },
    });
    await sendOutbound(dependencies(), id);
    expect((await rowOf(id)).status).toBe("sent");
  });

  it("temporary: попытка засчитывается, повтор ставится с нарастающей паузой", async () => {
    channel.failNext({ ok: false, reason: "temporary", error: "сеть" });
    channel.failNext({ ok: false, reason: "temporary", error: "сеть" });
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), id);
    const afterFirst = jobs.at(-1)?.options?.delaySeconds ?? 0;
    await sendOutbound(dependencies(), id);
    const afterSecond = jobs.at(-1)?.options?.delaySeconds ?? 0;
    expect((await rowOf(id)).attempts).toBe(2);
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBeGreaterThan(afterFirst);
    expect((await rowOf(id)).status).toBe("queued");
    expect((await rowOf(id)).nextAttemptAt).toEqual(new Date(clock.now().getTime() + afterSecond * 1000));
  });

  it("temporary до предела: статус failed и сообщение об ошибке эксперту", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      channel.failNext({ ok: false, reason: "temporary", error: "сеть" });
    }
    const { id } = await enqueueOutbound(dependencies({ maxAttempts: 3 }), draft());
    for (let attempt = 0; attempt < 3; attempt += 1) await sendOutbound(dependencies({ maxAttempts: 3 }), id);
    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("сеть");
    expect(failures).toEqual([{ id, error: "сеть" }]);
  });

  it("permanent: сразу failed, повторов нет", async () => {
    channel.failNext({ ok: false, reason: "permanent", error: "чат не найден" });
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), id);
    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("чат не найден");
    expect(failures).toEqual([{ id, error: "чат не найден" }]);
    expect(jobs).toHaveLength(1);
  });

  it("permanent по вине бота (токен отозван): failed с пометкой «ждёт починки бота»", async () => {
    channel.failNext({ ok: false, reason: "permanent", error: "Unauthorized" });
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(
      dependencies({
        async onPermanentFailure() {
          return "bot";
        },
      }),
      id,
    );
    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(row.awaitsBotRepair).toBe(true);
  });

  it("permanent по вине самого сообщения: пометки «ждёт починки бота» нет", async () => {
    channel.failNext({ ok: false, reason: "permanent", error: "чат не найден" });
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), id);
    expect((await rowOf(id)).awaitsBotRepair).toBe(false);
  });

  it("получатель не найден (бот удалён): failed, а не тишина", async () => {
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies({ resolveTarget: async () => null }), id);
    expect((await rowOf(id)).status).toBe("failed");
    expect(failures).toHaveLength(1);
  });

  it("адаптер упал исключением — считаем временным сбоем", async () => {
    const { id } = await enqueueOutbound(dependencies(), draft());
    const broken = new FakeChannel();
    broken.send = async () => {
      throw new Error("socket hang up");
    };
    await sendOutbound(
      dependencies({ resolveTarget: async () => ({ adapter: broken, bot, to: TELEGRAM_USER }) }),
      id,
    );
    const row = await rowOf(id);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.error).toBe("socket hang up");
  });

  it("нечего отправлять (пустое сообщение): статус failed с понятной причиной, без повторов и без тревоги о боте", async () => {
    channel.failNext({ ok: false, reason: "empty" });
    const { id } = await enqueueOutbound(dependencies(), draft());
    vi.spyOn(console, "error").mockImplementation(() => {});
    await sendOutbound(dependencies(), id);
    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Пустое сообщение: отправлять нечего");
    expect(failures).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("прогресс частей: временный сбой после первой части запоминается и передаётся адаптеру при повторе", async () => {
    channel.failNext({ ok: false, reason: "temporary", error: "сеть", sentParts: 1 });
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), id);
    expect((await rowOf(id)).sentParts).toBe(1);

    await sendOutbound(dependencies(), id);
    expect(channel.sent[0]?.message.sentParts).toBe(1);
    expect((await rowOf(id)).status).toBe("sent");
  });

  it("прогресс частей: rate_limited тоже запоминает ушедшие части и не тратит попытку", async () => {
    channel.failNext({ ok: false, reason: "rate_limited", retryAfterMs: 1000, sentParts: 2 });
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), id);
    const row = await rowOf(id);
    expect(row).toMatchObject({ sentParts: 2, attempts: 0, status: "queued" });
  });

  it("первая отправка идёт без прогресса (sentParts: 0)", async () => {
    const { id } = await enqueueOutbound(dependencies(), draft());
    await sendOutbound(dependencies(), id);
    expect(channel.sent[0]?.message.sentParts).toBe(0);
  });

  it("неизвестное сообщение — ошибка, а не тихий пропуск", async () => {
    await expect(sendOutbound(dependencies(), randomUUID())).rejects.toThrow();
  });
});
