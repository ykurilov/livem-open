// Решение о входящем записано, а действия после него (первое сообщение, закрепление сценария) не выполнились,
// пока очередь не исчерпала повторы: их доводит подмётчик
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { BASE_SETTINGS, createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { newProgramSettings } from "../lead-magnets";
import { FOLLOW_UP_RECOVERY_MS } from "./sweep";

const MINUTE = 60_000;

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

/** Человек прошёл по ссылке, а очередь лежит дольше повторов: решение записано, первое сообщение не поставлено. */
async function startWhileQueueDown(code: string) {
  await kit.send(person, `/start ${code}`, { startCode: code });
  kit.queue.failNext(1);
  await expect(kit.drain()).rejects.toThrow(/Очередь недоступна/);
  expect((await kit.inboundOf(person))[0]).toMatchObject({ startedPassage: true });
  expect(kit.textsTo(person)).toEqual([]);
}

describe("подмётчик доводит действия после решения", () => {
  it("первое сообщение и закрепление: одно сообщение, начало программы — момент решения", async () => {
    const lead = await kit.publish({ program: newProgramSettings(3) });
    const decidedAt = kit.clock.now().getTime();
    await startWhileQueueDown(lead.code);
    const [passage] = await kit.passagesOf(person);
    expect(await kit.dialog.flow.readRun(passage!.personId, passage!.chatId)).toBeNull();

    kit.clock.advance(30 * MINUTE);
    await kit.dialog.sweepStuck();
    await kit.drain();

    expect(kit.textsTo(person)).toHaveLength(1);
    expect(kit.textsTo(person)[0]).toContain(BASE_SETTINGS.firstMessage!);
    expect((await kit.dialog.flow.readRun(passage!.personId, passage!.chatId))?.startedAt).toBe(decidedAt);

    // Доведено: следующий проход подмётчика разбор не повторяет
    const routes = kit.queue.count("inbound-route");
    kit.clock.advance(MINUTE);
    await kit.dialog.sweepStuck();
    await kit.drain();
    expect(kit.queue.count("inbound-route")).toBe(routes);
    expect(kit.textsTo(person)).toHaveLength(1);
  });

  it("первое сообщение ушло, а закрепление падало до конца повторов — закрепляет, второго сообщения нет", async () => {
    const lead = await kit.publish({ program: newProgramSettings(3) });
    const decidedAt = kit.clock.now().getTime();
    const flow = kit.dialog.flow;
    const adopt = flow.adopt.bind(flow);
    let failures = 1;
    flow.adopt = async (input) => {
      if (failures-- > 0) throw new Error("Connection terminated unexpectedly");
      return adopt(input);
    };
    await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
    await expect(kit.drain()).rejects.toThrow(/Connection terminated/);

    kit.clock.advance(20 * MINUTE);
    await kit.dialog.sweepStuck();
    await kit.drain();

    const [passage] = await kit.passagesOf(person);
    expect((await flow.readRun(passage!.personId, passage!.chatId))?.startedAt).toBe(decidedAt);
    expect(kit.textsTo(person)).toHaveLength(1);
  });

  it("переход на другой лидмагнит: конец старого сценария, падавший до конца повторов, доводится", async () => {
    const first = await kit.publish();
    const second = await kit.publish({ firstMessage: "Другой лидмагнит" });
    await kit.send(person, `/start ${first.code}`, { startCode: first.code });
    await kit.drain();
    const [old] = await kit.passagesOf(person);
    const flow = kit.dialog.flow;
    const end = flow.end.bind(flow);
    let failures = 1;
    flow.end = async (input) => {
      if (failures-- > 0) throw new Error("Connection terminated unexpectedly");
      return end(input);
    };
    await kit.send(person, `/start ${second.code}`, { startCode: second.code });
    await expect(kit.drain()).rejects.toThrow(/Connection terminated/);

    kit.clock.advance(20 * MINUTE);
    await kit.dialog.sweepStuck();
    await kit.drain();

    expect((await flow.readRun(old!.personId, old!.chatId))?.endReason).toBe("switched");
    expect(kit.textsTo(person).filter((text) => text.includes("Другой лидмагнит"))).toHaveLength(1);
  });

  // Последний в файле: недоведённая запись остаётся, а часы следующего набора начинаются с того же утра
  it("позже окна восстановления приветствие не приходит", async () => {
    const lead = await kit.publish();
    await startWhileQueueDown(lead.code);
    const routes = kit.queue.count("inbound-route");

    kit.clock.advance(FOLLOW_UP_RECOVERY_MS + MINUTE);
    await kit.dialog.sweepStuck();
    await kit.drain();

    expect(kit.queue.count("inbound-route")).toBe(routes);
    expect(kit.textsTo(person)).toEqual([]);
  });
});
