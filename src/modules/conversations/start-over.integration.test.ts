// «Начать заново» в карточке человека: разговор закрывается, лидмагнит можно пройти снова с чистого листа
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { bots, outboundMessages } from "../channels/schema";
import { newProgramSettings } from "../lead-magnets";
import { people } from "../people/schema";
import { passages } from "./schema";
import { startConversationsOver } from "./start-over";

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

async function say(text: string, startCode?: string) {
  await kit.send(person, text, startCode ? { startCode } : {});
  await kit.drain();
}

async function startOver() {
  const found = await kit.personOf(person);
  return startConversationsOver(database.db, found!.id, kit.clock.now());
}

describe("«Начать заново» в карточке человека", () => {
  it("идущий разговор закрывается как «не завершил»; поля и факты человека остаются", async () => {
    const lead = await kit.publish();
    await say(`/start ${lead.code}`, lead.code);
    const found = await kit.personOf(person);
    const facts = [{ text: "Двое детей", at: kit.clock.now().toISOString(), source: "test" }];
    await database.db.update(people).set({ fieldValues: { phone: "+79990000000" }, facts }).where(eq(people.id, found!.id));

    expect(await startOver()).toBe(true);

    expect(await kit.passagesOf(person)).toEqual([expect.objectContaining({ status: "not_completed" })]);
    const after = await kit.personOf(person);
    expect(after).toMatchObject({ fieldValues: { phone: "+79990000000" }, facts });
  });

  it("человека нет — ничего не делает", async () => {
    expect(await startConversationsOver(database.db, randomUUID(), kit.clock.now())).toBe(false);
  });

  it("законченную программу та же ссылка начинает заново — с новым чатом и первым сообщением", async () => {
    const lead = await kit.publish({ program: newProgramSettings(3), firstMessage: "День первый!" });
    await say(`/start ${lead.code}`, lead.code);
    await database.db.update(passages).set({ status: "completed", endedAt: kit.clock.now() });
    await say(`/start ${lead.code}`, lead.code);
    expect(await kit.passagesOf(person)).toHaveLength(1);

    await startOver();
    await say(`/start ${lead.code}`, lead.code);

    const [old, fresh] = await kit.passagesOf(person);
    expect(fresh).toMatchObject({ leadMagnetId: lead.leadMagnetId, status: "active" });
    expect(fresh!.chatId).not.toBe(old!.chatId);
    expect(kit.textsTo(person).at(-1)).toContain("День первый!");
  });

  it("после сброса сообщение без кода — как от новичка: лидмагнит по умолчанию с начала, а не прежний разговор и не «Входящие»", async () => {
    const wrong = await kit.publish({ firstMessage: "Не тот" });
    const byDefault = await kit.publish({ firstMessage: "Тот самый" });
    await say(`/start ${wrong.code}`, wrong.code);
    const found = await kit.personOf(person);
    // Эксперт отвечал из «Входящих» до сброса — после сброса это не мешает
    await database.db.insert(outboundMessages).values({
      botId: kit.bot.id,
      personId: found!.id,
      kind: "manual_reply",
      text: "Добрый день",
      status: "sent",
      sentAt: kit.clock.now(),
      idempotencyKey: `manual-${randomUUID()}`,
    });
    await database.db.update(bots).set({ noCodeMode: "default", defaultLeadMagnetId: byDefault.leadMagnetId }).where(eq(bots.id, kit.bot.id));

    await startOver();
    await say("/start");

    const rows = await kit.passagesOf(person);
    expect(rows.map((row) => [row.leadMagnetId, row.status])).toEqual([
      [wrong.leadMagnetId, "not_completed"],
      [byDefault.leadMagnetId, "active"],
    ]);
    expect(kit.textsTo(person).at(-1)).toContain("Тот самый");
    await say("Привет");
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "passage", passageId: rows[1]!.id });
  });

  it("без сброса брошенный разговор по-прежнему продолжается, а не начинается заново", async () => {
    const lead = await kit.publish();
    await database.db.update(bots).set({ noCodeMode: "default", defaultLeadMagnetId: lead.leadMagnetId }).where(eq(bots.id, kit.bot.id));
    await say("Привет");
    await database.db.update(passages).set({ status: "not_completed", endedAt: kit.clock.now() });

    await say("Я вернулся");

    expect(await kit.passagesOf(person)).toHaveLength(1);
  });
});
