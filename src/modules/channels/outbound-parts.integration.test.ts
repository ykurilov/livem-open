// Сценарии «сообщение из нескольких частей» с настоящим адаптером Telegram и подделкой сервера.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createFakeClock } from "../platform/clock";
import type { EnqueueOptions, JobEnqueuer, JobName, JobPayloads } from "../platform/queue";
import type { BotCredentials } from "./channel";
import { enqueueOutbound, requeueAfterBotRepair, sendOutbound, type OutboundDependencies } from "./outbound";
import { outboundMessages } from "./schema";
import { createTelegramAdapter } from "./telegram/adapter";
import { FakeTelegramApi, telegramError } from "./telegram/fake-telegram-api";

const bot: BotCredentials = {
  id: randomUUID(),
  token: "123456789:AA-secret",
  externalId: "123456789",
  username: "live_magnet_bot",
  webhookSecret: "hook",
};

let database: TestDatabase;
let api: FakeTelegramApi;
let jobs: Array<{ name: JobName; payload: JobPayloads[JobName]; options?: EnqueueOptions }>;

const queue: JobEnqueuer = {
  async enqueue(name, payload, options) {
    jobs.push({ name, payload, options });
  },
};

function dependencies(failureCause: "bot" | "message" = "message"): OutboundDependencies {
  const adapter = createTelegramAdapter({ fetch: api.fetch });
  return {
    db: database.db,
    queue,
    clock: createFakeClock(new Date("2026-10-10T09:00:00Z")),
    async resolveTarget() {
      return { adapter, bot, to: "5550001" };
    },
    async onBlocked() {},
    async onPermanentFailure() {
      return failureCause;
    },
  };
}

async function rowOf(id: string) {
  const [row] = await database.db.select().from(outboundMessages).where(eq(outboundMessages.id, id));
  if (!row) throw new Error(`Нет сообщения ${id}`);
  return row;
}

const enqueue = (text: string, imagePath?: string) =>
  enqueueOutbound(dependencies(), {
    botId: bot.id,
    personId: randomUUID(),
    kind: "consultant",
    text,
    imagePath,
    idempotencyKey: randomUUID(),
  });

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("delete from app.outbound_messages");
  api = new FakeTelegramApi();
  jobs = [];
});

describe("повтор отправки не шлёт уже отправленное", () => {
  it("фото ушло, текст получил 429: после повтора фото отправлено ровно один раз", async () => {
    api.replyOnce("sendMessage", telegramError(429, "Too Many Requests", { retry_after: 2 }));
    const { id } = await enqueue("а".repeat(1500), "https://cdn.test/cover.png");

    await sendOutbound(dependencies(), id);
    expect(await rowOf(id)).toMatchObject({ status: "queued", sentParts: 1, attempts: 0 });
    expect(jobs.at(-1)).toMatchObject({ name: "outbound-send", options: { delaySeconds: 2 } });

    await sendOutbound(dependencies(), id);
    expect((await rowOf(id)).status).toBe("sent");
    expect(api.callsTo("sendPhoto")).toHaveLength(1);
    expect(api.callsTo("sendMessage")).toHaveLength(2);
  });

  it("фото ушло, текст получил временный сбой: повтор тоже не дублирует фото", async () => {
    api.replyOnce("sendMessage", telegramError(502, "Bad Gateway"));
    const { id } = await enqueue("а".repeat(1500), "https://cdn.test/cover.png");
    await sendOutbound(dependencies(), id);
    expect(await rowOf(id)).toMatchObject({ status: "queued", sentParts: 1, attempts: 1 });
    await sendOutbound(dependencies(), id);
    expect(api.callsTo("sendPhoto")).toHaveLength(1);
    expect((await rowOf(id)).status).toBe("sent");
  });

  it("длинный текст из трёх частей: сбой на второй, повтор шлёт вторую и третью, первая не дублируется", async () => {
    const text = `${"а".repeat(3000)}\n\n${"б".repeat(3000)}\n\n${"в".repeat(3000)}`;
    api.replyOnce("sendMessage", { status: 200, body: { ok: true, result: { message_id: 1 } } });
    api.replyOnce("sendMessage", telegramError(500, "Internal Server Error"));
    const { id } = await enqueue(text);

    await sendOutbound(dependencies(), id);
    expect(await rowOf(id)).toMatchObject({ status: "queued", sentParts: 1 });

    await sendOutbound(dependencies(), id);
    const row = await rowOf(id);
    expect(row.status).toBe("sent");
    const bodies = api.callsTo("sendMessage").map((call) => (call.body as { text: string }).text[0]);
    expect(bodies).toEqual(["а", "б", "б", "в"]);
  });

  it("фото ушло, текст упал из-за отозванного токена: после починки бота фото второй раз не уходит", async () => {
    api.replyOnce("sendMessage", telegramError(401, "Unauthorized"));
    const { id } = await enqueue("а".repeat(1500), "https://cdn.test/cover.png");

    await sendOutbound(dependencies("bot"), id);
    expect(await rowOf(id)).toMatchObject({ status: "failed", sentParts: 1, awaitsBotRepair: true });

    await requeueAfterBotRepair({ db: database.db, queue }, bot.id);
    await sendOutbound(dependencies(), id);
    expect((await rowOf(id)).status).toBe("sent");
    expect(api.callsTo("sendPhoto")).toHaveLength(1);
    expect(api.callsTo("sendMessage")).toHaveLength(2);
  });

  it("пустое сообщение: в Telegram не уходит, запись failed с понятной причиной", async () => {
    const { id } = await enqueue("   ");
    await sendOutbound(dependencies(), id);
    expect(api.requests).toEqual([]);
    expect(await rowOf(id)).toMatchObject({ status: "failed", error: "Пустое сообщение: отправлять нечего" });
  });
});
