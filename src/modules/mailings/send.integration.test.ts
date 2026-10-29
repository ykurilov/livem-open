import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createMailingKit, type MailingKit } from "../../../tests/integration/mailing-kit";
import { bots, outboundMessages } from "../channels/schema";
import { inboundMessages } from "../conversations/schema";
import { people } from "../people/schema";
import {
  MailingError,
  cancelMailing,
  createMailing,
  getMailing,
  launchMailing,
  loadMailingReport,
  parseMskDateTime,
  sendMailingTest,
} from "./index";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let database: TestDatabase;
let kit: MailingKit;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  // 1 октября, 12:00 по Москве
  kit = await createMailingKit(database, { start: new Date("2026-10-01T09:00:00Z") });
});

/** Входящее от человека в заданный момент — так тест задаёт «ответил» без хода консультанта. */
async function replyAt(person: { id: string; userId: string }, at: Date) {
  await kit.db.insert(inboundMessages).values({
    botId: kit.bot.id,
    kind: "message",
    dedupeKey: `reply-${randomUUID()}`,
    externalUserId: person.userId,
    text: "Спасибо!",
    personId: person.id,
    route: "inbox",
    receivedAt: at,
    processedAt: at,
  });
}

describe("время по Москве", () => {
  it("«2026-10-01T18:00» по Москве — это 15:00 UTC", () => {
    expect(parseMskDateTime("2026-10-01T18:00").toISOString()).toBe("2026-10-01T15:00:00.000Z");
    expect(() => parseMskDateTime("завтра")).toThrow(MailingError);
  });
});

describe("расписание", () => {
  it("отложенная на 18:00 по Москве уходит в 18:00, не раньше", async () => {
    const anna = await kit.addPerson();
    const mailing = await createMailing(kit.db, { text: "Эфир через час", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id, { at: parseMskDateTime("2026-10-01T18:00") });
    expect((await getMailing(kit.db, mailing.id))?.status).toBe("scheduled");

    kit.clock.set(new Date("2026-10-01T14:59:00Z"));
    await kit.runDueAll();
    expect(kit.textsTo(anna.userId)).toEqual([]);

    await kit.drainAll();
    expect(kit.textsTo(anna.userId)).toEqual(["Эфир через час"]);
    const [sent] = await kit.db.select().from(outboundMessages).where(eq(outboundMessages.mailingId, mailing.id));
    expect(sent!.sentAt!.getTime()).toBeGreaterThanOrEqual(new Date("2026-10-01T15:00:00Z").getTime());
    expect((await getMailing(kit.db, mailing.id))?.status).toBe("done");
  });

  it("время в прошлом не принимается", async () => {
    const mailing = await createMailing(kit.db, { text: "Поздно", filter: {} });
    await expect(launchMailing(kit, mailing.id, { at: new Date(kit.clock.now().getTime() - MINUTE) })).rejects.toThrow(MailingError);
  });

  it("отменённая до старта не уходит никому", async () => {
    const anna = await kit.addPerson();
    const mailing = await createMailing(kit.db, { text: "Не отправлять", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id, { at: new Date(kit.clock.now().getTime() + HOUR) });
    await cancelMailing(kit, mailing.id);
    await kit.drainAll();

    expect(kit.textsTo(anna.userId)).toEqual([]);
    expect((await getMailing(kit.db, mailing.id))?.status).toBe("cancelled");
    expect(await kit.db.select().from(outboundMessages).where(eq(outboundMessages.mailingId, mailing.id))).toEqual([]);
  });

  it("начавшуюся рассылку отменить нельзя", async () => {
    await kit.addPerson();
    const mailing = await createMailing(kit.db, { text: "Уже идёт", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id);
    await kit.drainAll();
    await expect(cancelMailing(kit, mailing.id)).rejects.toThrow(MailingError);
  });
});

describe("постепенная отправка", () => {
  it("не больше `ratePerSecond` сообщений бота в секунду", async () => {
    for (let i = 0; i < 120; i++) await kit.addPerson();
    const moments: number[] = [];
    const send = kit.channel.send.bind(kit.channel);
    kit.channel.send = async (...args) => {
      moments.push(kit.clock.now().getTime());
      return send(...args);
    };

    const mailing = await createMailing(kit.db, { text: "Всем привет", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id);
    await kit.drainAll();

    expect(moments).toHaveLength(120);
    const perSecond = new Map<number, number>();
    for (const at of moments) perSecond.set(Math.floor(at / 1000), (perSecond.get(Math.floor(at / 1000)) ?? 0) + 1);
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(kit.channel.ratePerSecond);
  });

  it("временный сбой — повтор, сообщение не теряется", async () => {
    const anna = await kit.addPerson();
    kit.channel.failNext({ ok: false, reason: "temporary", error: "сеть" });
    const mailing = await createMailing(kit.db, { text: "Повтор", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id);
    await kit.drainAll();
    expect(kit.textsTo(anna.userId)).toEqual(["Повтор"]);
    expect((await loadMailingReport(kit.db, mailing.id))?.sent).toBe(1);
  });
});

describe("отчёт", () => {
  it("ушло, не доставлено с пометкой «заблокировал», ответили в течение 7 дней", async () => {
    const anna = await kit.addPerson({ name: "Аня" });
    const boris = await kit.addPerson({ name: "Боря" });
    const vera = await kit.addPerson({ name: "Вера" });
    const gleb = await kit.addPerson({ name: "Глеб" });
    kit.channel.blockUser(gleb.userId);
    // Ответ до рассылки ответом на неё не считается
    await replyAt(boris, new Date(kit.clock.now().getTime() - HOUR));

    const mailing = await createMailing(kit.db, { text: "Как дела?", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id);
    await kit.drainAll();

    await replyAt(anna, new Date(kit.clock.now().getTime() + 2 * DAY));
    await replyAt(vera, new Date(kit.clock.now().getTime() + 8 * DAY));

    const report = await loadMailingReport(kit.db, mailing.id);
    expect(report).toMatchObject({ recipients: 4, sent: 3, failed: 1, blocked: 1, replied: 1, waiting: 0 });
    const glebRow = report!.people.find((row) => row.personId === gleb.id);
    expect(glebRow).toMatchObject({ outcome: "blocked", displayName: "Глеб" });
    expect(report!.people.find((row) => row.personId === anna.id)).toMatchObject({ outcome: "sent", replied: true });
    expect((await kit.db.select().from(people).where(eq(people.id, gleb.id)))[0]?.blockedAt).not.toBeNull();
  });

  it("1000 получателей уходят все, отчёт готов меньше чем через час (SC-007)", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      channel: "telegram" as const,
      botId: kit.bot.id,
      externalUserId: `bulk-${i}-${randomUUID().slice(0, 6)}`,
    }));
    await kit.db.insert(people).values(rows);
    const startedAt = kit.clock.now().getTime();

    const mailing = await createMailing(kit.db, { text: "Большая рассылка", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id);
    await kit.drainAll(20_000);

    const done = await getMailing(kit.db, mailing.id);
    expect(done?.status).toBe("done");
    expect(done!.finishedAt!.getTime() - startedAt).toBeLessThan(HOUR);
    expect(kit.channel.sent.filter((entry) => entry.message.text === "Большая рассылка")).toHaveLength(1000);
    expect(await loadMailingReport(kit.db, mailing.id)).toMatchObject({ recipients: 1000, sent: 1000, failed: 0 });
  }, 120_000);
});

describe("бот отключён во время рассылки (T097)", () => {
  it("недоставленные помечаются в отчёте, эксперт получает тревогу", async () => {
    const anna = await kit.addPerson();
    const mailing = await createMailing(kit.db, { text: "Вечерний эфир", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id, { at: new Date(kit.clock.now().getTime() + HOUR) });
    await kit.db.update(bots).set({ status: "error", statusError: "Токен отозван" }).where(eq(bots.id, kit.bot.id));
    await kit.drainAll();

    expect(kit.textsTo(anna.userId)).toEqual([]);
    const report = await loadMailingReport(kit.db, mailing.id);
    expect(report).toMatchObject({ recipients: 1, sent: 0, failed: 1, blocked: 0 });
    expect(report!.people[0]).toMatchObject({ outcome: "failed" });
    expect(report!.people[0]!.error).toContain("отключён");
    expect(kit.alertTexts.some((text) => text.includes("Вечерний эфир"))).toBe(true);
    expect((await getMailing(kit.db, mailing.id))?.status).toBe("done");
  });

  it("бот удалён после запуска: получатели помечаются недоставленными без тревоги", async () => {
    const anna = await kit.addPerson();
    const mailing = await createMailing(kit.db, { text: "Утренний эфир", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id, { at: new Date(kit.clock.now().getTime() + HOUR) });
    kit.clock.advance(HOUR);
    await kit.mailing.start(mailing.id);
    // Получатели зафиксированы, а бот удалили до первой порции
    await kit.db.update(bots).set({ deletedAt: kit.clock.now() }).where(eq(bots.id, kit.bot.id));
    await kit.drainAll();

    expect(kit.textsTo(anna.userId)).toEqual([]);
    const report = await loadMailingReport(kit.db, mailing.id);
    expect(report).toMatchObject({ recipients: 1, sent: 0, failed: 1 });
    expect(report!.people[0]!.error).toContain("удалён");
    expect(kit.alertTexts.some((text) => text.includes("Утренний эфир"))).toBe(false);
    expect((await getMailing(kit.db, mailing.id))?.status).toBe("done");
  });
});

describe("«Отправить себе»", () => {
  it("проба уходит выбранному человеку и в отчёт не попадает", async () => {
    const me = await kit.addPerson({ name: "Я сам" });
    const mailing = await createMailing(kit.db, { text: "Проба", filter: { botIds: [kit.bot.id] } });
    await sendMailingTest(kit, mailing.id, me.id, randomUUID());
    await kit.drainAll();

    expect(kit.textsTo(me.userId)).toEqual(["Проба"]);
    expect((await getMailing(kit.db, mailing.id))).toMatchObject({ status: "draft", testPersonId: me.id });
    expect(await loadMailingReport(kit.db, mailing.id)).toMatchObject({ recipients: 0, sent: 0 });
  });

  it("заблокировавшему бота и человеку удалённого бота проба не уходит", async () => {
    const blocked = await kit.addPerson({ blocked: true });
    const vkBot = await kit.addBot("vk");
    const gone = await kit.addPerson({ botId: vkBot, channel: "vk" });
    await kit.db.update(bots).set({ deletedAt: kit.clock.now() }).where(eq(bots.id, vkBot));
    const mailing = await createMailing(kit.db, { text: "Проба", filter: {} });

    await expect(sendMailingTest(kit, mailing.id, blocked.id, randomUUID())).rejects.toThrow(MailingError);
    await expect(sendMailingTest(kit, mailing.id, gone.id, randomUUID())).rejects.toThrow(MailingError);
    const outbound = await kit.db.select().from(outboundMessages);
    expect(outbound.filter((row) => row.personId === blocked.id || row.personId === gone.id)).toEqual([]);
  });
});
