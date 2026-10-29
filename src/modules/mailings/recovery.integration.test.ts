import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createMailingKit, type MailingKit } from "../../../tests/integration/mailing-kit";
import { bots, outboundMessages } from "../channels/schema";
import type { JobName } from "../platform/queue";
import { BOT_DOWN_GRACE_MS, createMailing, getMailing, launchMailing, loadMailingReport } from "./index";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

let database: TestDatabase;
let kit: MailingKit;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createMailingKit(database, { start: new Date("2026-10-01T09:00:00Z") });
});

const isFor = (mailingId: string, name: JobName) => (job: { name: JobName; payload: unknown }) =>
  job.name === name && (job.payload as { mailingId?: string }).mailingId === mailingId;

const pending = (mailingId: string, name: JobName) => kit.queue.pending.filter(isFor(mailingId, name)).length;

/** Задача рассылки пропала из очереди: работник упал, повторы исчерпаны. */
function lose(mailingId: string, name: JobName) {
  for (let index = kit.queue.pending.length - 1; index >= 0; index--)
    if (isFor(mailingId, name)(kit.queue.pending[index]!)) kit.queue.pending.splice(index, 1);
}

/** Выполняет задачи, двигая часы, но не дальше чем на `ms` вперёд. */
async function runFor(ms: number) {
  const end = kit.clock.now().getTime() + ms;
  for (;;) {
    await kit.runDueAll();
    const next = kit.queue.nextRunAt();
    if (next === undefined || next > end) break;
    kit.clock.set(new Date(Math.max(next, kit.clock.now().getTime())));
  }
  kit.clock.set(new Date(end));
  await kit.runDueAll();
}

const setBotStatus = (status: "ok" | "error") =>
  kit.db.update(bots).set({ status, statusError: status === "ok" ? null : "Сеть недоступна" }).where(eq(bots.id, kit.bot.id));

async function outboundCountTo(personId: string) {
  return (await kit.db.select().from(outboundMessages).where(eq(outboundMessages.personId, personId))).length;
}

describe("бот временно не в порядке", () => {
  it("бот вернулся за 15 минут — получатели дождались и получили сообщение, тревоги нет", async () => {
    const anna = await kit.addPerson();
    await setBotStatus("error");
    const mailing = await createMailing(kit.db, { text: "Эфир через час", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id);

    await runFor(10 * MINUTE);
    expect(kit.textsTo(anna.userId)).toEqual([]);
    expect(await loadMailingReport(kit.db, mailing.id)).toMatchObject({ recipients: 1, waiting: 1, failed: 0 });

    await setBotStatus("ok");
    await kit.drainAll();
    expect(kit.textsTo(anna.userId)).toEqual(["Эфир через час"]);
    expect(kit.alertTexts.some((text) => text.includes("Эфир через час"))).toBe(false);
    expect((await getMailing(kit.db, mailing.id))?.status).toBe("done");
  });

  it("бот не вернулся за 15 минут — «не доставлено» и тревога", async () => {
    const anna = await kit.addPerson();
    await setBotStatus("error");
    const mailing = await createMailing(kit.db, { text: "Эфир завтра", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id);

    await runFor(BOT_DOWN_GRACE_MS - MINUTE);
    expect(await loadMailingReport(kit.db, mailing.id)).toMatchObject({ waiting: 1, failed: 0 });
    expect(kit.alertTexts.some((text) => text.includes("Эфир завтра"))).toBe(false);

    await runFor(2 * MINUTE);
    const report = await loadMailingReport(kit.db, mailing.id);
    expect(report).toMatchObject({ waiting: 0, failed: 1 });
    expect(report!.people[0]!.error).toContain("отключён");
    expect(kit.alertTexts.some((text) => text.includes("Эфир завтра"))).toBe(true);
    expect(kit.textsTo(anna.userId)).toEqual([]);
    expect((await getMailing(kit.db, mailing.id))?.status).toBe("done");
  });
});

describe("подмётчик рассылок", () => {
  it("запланированная рассылка, чья задача старта потерялась, всё равно уходит", async () => {
    const anna = await kit.addPerson();
    const mailing = await createMailing(kit.db, { text: "Старт потерялся", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id, { at: new Date(kit.clock.now().getTime() + HOUR) });
    lose(mailing.id, "mailing-start");

    kit.clock.advance(HOUR + 2 * MINUTE);
    await kit.mailing.sweep();
    await kit.drainAll();
    expect(kit.textsTo(anna.userId)).toEqual(["Старт потерялся"]);
    expect((await getMailing(kit.db, mailing.id))?.status).toBe("done");
  });

  it("идущая рассылка, чья порция потерялась, продолжается", async () => {
    const anna = await kit.addPerson();
    const mailing = await createMailing(kit.db, { text: "Порция потерялась", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id);
    lose(mailing.id, "mailing-start");
    await kit.mailing.start(mailing.id);
    lose(mailing.id, "mailing-batch");

    kit.clock.advance(2 * MINUTE);
    await kit.mailing.sweep();
    expect(pending(mailing.id, "mailing-batch")).toBe(1);
    await kit.drainAll();
    expect(kit.textsTo(anna.userId)).toEqual(["Порция потерялась"]);
  });

  it("рассылку с порцией в пути и ещё не наступившую не трогает", async () => {
    await kit.addPerson();
    const going = await createMailing(kit.db, { text: "Идёт", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, going.id);
    lose(going.id, "mailing-start");
    await kit.mailing.start(going.id);
    const later = await createMailing(kit.db, { text: "Позже", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, later.id, { at: new Date(kit.clock.now().getTime() + HOUR) });

    kit.clock.advance(5 * SECOND);
    await kit.mailing.sweep();
    expect(pending(going.id, "mailing-batch")).toBe(1);
    expect(pending(later.id, "mailing-start")).toBe(1);
  });
});

describe("повторы задач не задваивают рассылку", () => {
  it("дубль mailing-start — одна цепочка порций, одно сообщение каждому", async () => {
    const anna = await kit.addPerson();
    const boris = await kit.addPerson();
    const mailing = await createMailing(kit.db, { text: "Один раз", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id);
    await kit.mailing.start(mailing.id);
    await kit.mailing.start(mailing.id);
    expect(pending(mailing.id, "mailing-batch")).toBe(1);

    await kit.drainAll();
    expect(kit.textsTo(anna.userId)).toEqual(["Один раз"]);
    expect(kit.textsTo(boris.userId)).toEqual(["Один раз"]);
    expect(await outboundCountTo(anna.id)).toBe(1);
  });

  it("повтор mailing-batch не отправляет второй раз и не плодит цепочки", async () => {
    const anna = await kit.addPerson();
    const mailing = await createMailing(kit.db, { text: "Без повторов", filter: { botIds: [kit.bot.id] } });
    await launchMailing(kit, mailing.id);
    lose(mailing.id, "mailing-start");
    await kit.mailing.start(mailing.id);
    await kit.mailing.batch(mailing.id);
    // Очередь повторила ту же порцию: например, работник упал, не отметив её выполненной
    await kit.mailing.batch(mailing.id);
    kit.clock.advance(BOT_DOWN_GRACE_MS);
    await kit.mailing.batch(mailing.id);

    await kit.drainAll();
    expect(kit.textsTo(anna.userId)).toEqual(["Без повторов"]);
    expect(await outboundCountTo(anna.id)).toBe(1);
    expect(pending(mailing.id, "mailing-batch")).toBe(0);
    expect((await getMailing(kit.db, mailing.id))?.status).toBe("done");
  });

  it("повтор порции не ставит вторую следующую порцию", async () => {
    const vkBot = await kit.addBot("vk");
    // ВК шлёт 15 в секунду: 200 человек — больше одной порции
    for (let index = 0; index < 200; index++) await kit.addPerson({ botId: vkBot, channel: "vk" });
    const mailing = await createMailing(kit.db, { text: "Много", filter: { botIds: [vkBot] } });
    await launchMailing(kit, mailing.id);
    lose(mailing.id, "mailing-start");
    await kit.mailing.start(mailing.id);
    lose(mailing.id, "mailing-batch");
    await kit.mailing.batch(mailing.id);
    await kit.mailing.batch(mailing.id);
    expect(pending(mailing.id, "mailing-batch")).toBe(1);
  });
});
