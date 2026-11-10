import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, DEFAULT_CONSULTANT_REPLY, KIT_CIPHER, outboundOf, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { inboxThreads, loadInboxThread } from "../inbox";
import { updateSettings } from "../platform/settings";
import { checkAllBots } from "./bot-health";

let database: TestDatabase;
let kit: LiveDialogKit;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await updateSettings(database.db, { monthlyBudgetUsd: null, dailyLimitUsd: "1000" });
  kit = await createLiveDialogKit(database, { pricePerMillion: 0 });
});

const newUser = () => `user-${randomUUID().slice(0, 8)}`;

async function say(user: string, text: string, startCode?: string) {
  await kit.send(user, text, startCode ? { startCode } : {});
  await kit.drain();
}

const checkBots = () => checkAllBots({ db: kit.db, queue: kit.queue, alerts: kit.alerts, adapters: kit.dialogAdapters, cipher: KIT_CIPHER });

async function unansweredOf(user: string) {
  const person = (await kit.personOf(user))!;
  const [thread] = await kit.db.select().from(inboxThreads).where(eq(inboxThreads.personId, person.id));
  return thread?.unansweredCount ?? 0;
}

const answersTo = (user: string) => kit.textsTo(user).filter((text) => text === DEFAULT_CONSULTANT_REPLY);

/** Человек в разговоре; на его следующий вопрос связь с мессенджером пропадает: отправка и проверка бота не проходят. */
async function inConversationWhenConnectionDrops(user: string) {
  const lead = await kit.publish();
  await say(user, `/start ${lead.code}`, lead.code);
  kit.channel.breakConnection("fetch failed", "temporary");
  for (let attempt = 0; attempt < 5; attempt++) kit.channel.failNext({ ok: false, reason: "temporary", error: "fetch failed" });
}

describe("связь с мессенджером пропала на время ответа консультанта", () => {
  it("ответ ждёт связи, во «Входящие» не уходит; связь вернулась — уходит один раз", async () => {
    const user = newUser();
    await inConversationWhenConnectionDrops(user);
    await say(user, "Сколько стоит курс?");

    expect(await outboundOf(kit)).toContainEqual(expect.objectContaining({ kind: "consultant", status: "failed", awaitsBotRepair: true }));
    expect(answersTo(user)).toEqual([]);
    expect(await unansweredOf(user)).toBe(0);

    kit.channel.breakConnection(null);
    await checkBots();
    await kit.drain();
    await checkBots();
    await kit.drain();

    expect(answersTo(user)).toHaveLength(1);
    expect(await outboundOf(kit)).toContainEqual(expect.objectContaining({ kind: "consultant", status: "sent" }));
    expect(await unansweredOf(user)).toBe(0);
  });

  it("связи не было дольше 3 суток: устаревший ответ не уходит, вопрос — эксперту во «Входящие»", async () => {
    const user = newUser();
    await inConversationWhenConnectionDrops(user);
    await say(user, "Сколько стоит курс?");
    await database.pool.query(
      "update app.outbound_messages set created_at = now() - interval '3 days 1 minute' where bot_id = $1 and kind = 'consultant'",
      [kit.bot.id],
    );

    kit.channel.breakConnection(null);
    await checkBots();
    await kit.drain();

    expect(answersTo(user)).toEqual([]);
    const answer = (await outboundOf(kit)).find((row) => row.kind === "consultant" && row.text === DEFAULT_CONSULTANT_REPLY);
    expect(answer).toMatchObject({ status: "failed", awaitsBotRepair: false });
    expect(await unansweredOf(user)).toBe(1);
    const person = (await kit.personOf(user))!;
    expect((await loadInboxThread(kit.db, person.id))!.handoverReason).toMatch(/не дошёл/);
  });

  it("отказ самого ответа при временном сбое проверки бота — эксперту во «Входящие», как прежде", async () => {
    const user = newUser();
    const lead = await kit.publish();
    await say(user, `/start ${lead.code}`, lead.code);
    kit.channel.breakConnection("fetch failed", "temporary");
    kit.channel.failNext({ ok: false, reason: "permanent", error: "Bad Request: message is too long" });
    await say(user, "Сколько стоит курс?");

    expect(await outboundOf(kit)).toContainEqual(expect.objectContaining({ kind: "consultant", status: "failed", awaitsBotRepair: false }));
    expect(await unansweredOf(user)).toBe(1);
  });
});
