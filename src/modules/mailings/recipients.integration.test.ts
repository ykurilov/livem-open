import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createMailingKit, type MailingKit } from "../../../tests/integration/mailing-kit";
import { bots, outboundMessages } from "../channels/schema";
import { countRecipients, createMailing, getMailing, launchMailing, listMailingFilterOptions, listTestRecipients, mailingRecipients, TEST_RECIPIENTS_LIMIT } from "./index";

let database: TestDatabase;
let kit: MailingKit;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createMailingKit(database);
});

const recipientsOf = async (mailingId: string) =>
  (await kit.db.select().from(mailingRecipients).where(eq(mailingRecipients.mailingId, mailingId))).map((row) => row.personId).sort();

describe("получатели рассылки", () => {
  it("число по фильтру: без людей посреди лидмагнита и без заблокировавших бота", async () => {
    const done = await kit.addPerson();
    await kit.addPassage(done.id, "completed");
    await kit.addPerson();
    const busy = await kit.addPerson();
    await kit.addPassage(busy.id, "completed");
    await kit.addPassage(busy.id, "active");
    await kit.addPerson({ blocked: true });

    const filter = { botIds: [kit.bot.id] };
    expect(await countRecipients(kit.db, filter)).toBe(2);
    // Фильтр работает как в «Базе»: статус прохождения сужает круг
    expect(await countRecipients(kit.db, { ...filter, statuses: ["completed"] })).toBe(1);
  });

  it("все три мессенджера: получатели из ботов Telegram, ВК и Max", async () => {
    const vkBot = await kit.addBot("vk");
    const maxBot = await kit.addBot("max");
    const telegram = await kit.addPerson();
    const vk = await kit.addPerson({ botId: vkBot, channel: "vk" });
    const max = await kit.addPerson({ botId: maxBot, channel: "max" });
    const filter = { botIds: [kit.bot.id, vkBot, maxBot] };

    expect(await countRecipients(kit.db, filter)).toBe(3);
    const mailing = await createMailing(kit.db, { text: "Привет всем", filter });
    await launchMailing(kit, mailing.id);
    await kit.runDueAll();

    expect(await recipientsOf(mailing.id)).toEqual([telegram.id, vk.id, max.id].sort());
    const outbound = await kit.db.select().from(outboundMessages).where(eq(outboundMessages.mailingId, mailing.id));
    expect(outbound.map((row) => row.personId).sort()).toEqual([telegram.id, vk.id, max.id].sort());
    expect(outbound.every((row) => row.kind === "mailing" && row.text === "Привет всем")).toBe(true);
  });

  it("получатели фиксируются при старте: число до отправки совпадает, пришедшие позже и начавшие лидмагнит не получают", async () => {
    const anna = await kit.addPerson();
    const boris = await kit.addPerson();
    const vera = await kit.addPerson();
    const filter = { botIds: [kit.bot.id] };
    const mailing = await createMailing(kit.db, { text: "Завтра эфир", filter });
    expect(await countRecipients(kit.db, filter)).toBe(3);

    await launchMailing(kit, mailing.id, { at: new Date(kit.clock.now().getTime() + 60 * 60_000) });
    // До старта Вера начала новый лидмагнит — в рассылку она уже не входит
    await kit.addPassage(vera.id, "active");
    kit.clock.advance(60 * 60_000);
    await kit.runDueAll();

    expect(await recipientsOf(mailing.id)).toEqual([anna.id, boris.id].sort());
    expect((await getMailing(kit.db, mailing.id))?.recipientCount).toBe(2);

    // Пришедший после старта в рассылку не попадает
    await kit.addPerson();
    await kit.drainAll();
    expect(await recipientsOf(mailing.id)).toEqual([anna.id, boris.id].sort());
    expect(kit.textsTo(anna.userId)).toEqual(["Завтра эфир"]);
    expect(kit.textsTo(vera.userId)).toEqual([]);
  });

  it("удалённый бот: его люди рассылку не получают, а сам бот не предлагается ни в фильтре, ни для пробы", async () => {
    const vkBot = await kit.addBot("vk");
    const kept = await kit.addPerson();
    const gone = await kit.addPerson({ botId: vkBot, channel: "vk" });
    await kit.db.update(bots).set({ deletedAt: kit.clock.now() }).where(eq(bots.id, vkBot));

    const filter = { botIds: [kit.bot.id, vkBot] };
    expect(await countRecipients(kit.db, filter)).toBe(1);
    expect(await countRecipients(kit.db, { botIds: [vkBot] })).toBe(0);
    const mailing = await createMailing(kit.db, { text: "Всем", filter });
    await launchMailing(kit, mailing.id);
    await kit.runDueAll();
    expect(await recipientsOf(mailing.id)).toEqual([kept.id]);

    const options = await listMailingFilterOptions(kit.db);
    expect(options.bots.map((bot) => bot.id)).toContain(kit.bot.id);
    expect(options.bots.map((bot) => bot.id)).not.toContain(vkBot);
    expect((await listTestRecipients(kit.db)).map((person) => person.id)).not.toContain(gone.id);
  });

  it("проба: поиск по имени находит любого человека, а список без поиска короткий", async () => {
    const tag = randomUUID().slice(0, 8);
    for (let index = 0; index < 25; index++) await kit.addPerson({ name: `А ${tag} ${index}` });
    const me = await kit.addPerson({ name: `Яна Тестова ${tag}` });

    const found = await listTestRecipients(kit.db, { query: `тестова ${tag}` });
    expect(found.map((person) => person.id)).toEqual([me.id]);
    expect((await listTestRecipients(kit.db, {})).length).toBe(TEST_RECIPIENTS_LIMIT);
    // Знаки шаблона в поиске — просто буквы
    expect(await listTestRecipients(kit.db, { query: "%" })).toEqual([]);
  });
});
