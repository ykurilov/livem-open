// Сообщения прохождения, не ушедшие из-за сломанного бота: после починки уходят, только если разговор ещё к месту
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { BASE_SETTINGS, KIT_CIPHER, createLiveDialogKit, outboundOf, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { checkAllBots } from "../channels";
import { passages } from "./schema";

const FIRST_MESSAGE = BASE_SETTINGS.firstMessage!;
const FAREWELL = BASE_SETTINGS.farewellMessage!;

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  person = `user-${randomUUID().slice(0, 8)}`;
});

/** Токен отозван: ближайшая отправка падает, проверка бота это подтверждает. */
function breakBot() {
  kit.channel.breakConnection("Unauthorized");
  kit.channel.failNext({ ok: false, reason: "permanent", error: "Unauthorized" });
}

async function repairBot() {
  kit.channel.breakConnection(null);
  await checkAllBots({ db: kit.db, queue: kit.queue, alerts: kit.alerts, adapters: { telegram: kit.channel }, cipher: KIT_CIPHER });
  await kit.drain();
}

async function startPassage() {
  const lead = await kit.publish();
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  return (await kit.passagesOf(person))[0]!;
}

async function closePassage(id: string) {
  await kit.db.update(passages).set({ status: "not_completed", endedAt: kit.clock.now() }).where(eq(passages.id, id));
}

describe("сообщения прохождения после починки бота", () => {
  it("разговор идёт: первое сообщение уходит после починки", async () => {
    breakBot();
    await startPassage();
    expect(kit.textsTo(person)).toEqual([]);

    await repairBot();
    expect(kit.textsTo(person)).toEqual([FIRST_MESSAGE]);
  });

  it("разговор уже закрыт: первое сообщение не уходит и больше не ждёт починки", async () => {
    breakBot();
    const passage = await startPassage();
    await closePassage(passage.id);

    await repairBot();
    expect(kit.textsTo(person)).toEqual([]);
    const [first] = await outboundOf(kit);
    expect(first).toMatchObject({ status: "failed", awaitsBotRepair: false });
  });

  it("разговор завершён: последний ответ консультанта с прощанием уходит после починки", async () => {
    await startPassage();
    breakBot();
    await kit.send(person, "Я готов, спасибо");
    await kit.drain();
    expect((await kit.passagesOf(person))[0]!.status).toBe("completed");
    expect(kit.textsTo(person)).toEqual([FIRST_MESSAGE]);

    await repairBot();
    expect(kit.textsTo(person)).toHaveLength(2);
    expect(kit.textsTo(person)[1]).toContain(FAREWELL);
  });
});
