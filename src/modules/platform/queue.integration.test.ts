import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createQueue, type AppQueue } from "./queue";

let database: TestDatabase;
let queue: AppQueue;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
  queue = createQueue({ connectionString: database.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await queue.start();
});

afterAll(async () => {
  await queue.stop();
  await database.drop();
});

function waitFor<T>(register: (resolve: (value: T) => void) => void, ms = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Задача не дошла до работника")), ms);
    register((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe("очередь задач", () => {
  it("отвечает на проверку", async () => {
    expect(await queue.ping()).toBe(true);
  });

  it("доставляет задачу работнику с её данными", async () => {
    const received = waitFor<{ outboundMessageId: string }>((resolve) => {
      void queue.work("outbound-send", async (payload) => resolve(payload));
    });
    await queue.enqueue("outbound-send", { outboundMessageId: "m-1" });
    expect(await received).toEqual({ outboundMessageId: "m-1" });
  });

  it("расписание сохраняется, повторный вызов заменяет его, а не дублирует", async () => {
    await queue.schedule("bot-health", "*/10 * * * *");
    await queue.schedule("bot-health", "*/10 * * * *");
    const rows = await database.pool.query("select name, cron from pgboss.schedule where name = 'bot-health'");
    expect(rows.rows).toEqual([{ name: "bot-health", cron: "*/10 * * * *" }]);
  });

  it("две задачи с одним ключом, пока первая ждёт, дают одну", async () => {
    const seen: string[] = [];
    await queue.enqueue("inbound-turn", { passageId: "p-1" }, { delaySeconds: 1, singletonKey: "p-1" });
    await queue.enqueue("inbound-turn", { passageId: "p-1" }, { delaySeconds: 1, singletonKey: "p-1" });
    const done = waitFor<void>((resolve) => {
      void queue.work("inbound-turn", async (payload) => {
        seen.push(payload.passageId);
        resolve();
      });
    });
    await done;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(seen).toEqual(["p-1"]);
  });
});

describe("цепочка ответа человеку", () => {
  let own: TestDatabase;
  let worker: AppQueue;
  let web: AppQueue;

  beforeAll(async () => {
    own = await createTestDatabase({ migrate: false });
    // Очередь из прежней версии, без уведомлений: обновление должно их включить
    const old = new PgBoss({ connectionString: own.url, schema: "pgboss", supervise: false, schedule: false });
    await old.start();
    await old.createQueue("inbound-route");
    await old.stop({ graceful: false });
    // Опрос реже, чем ждёт тест: задача дойдёт, только если работника разбудит уведомление
    worker = createQueue({ connectionString: own.url, role: "worker", pollingIntervalSeconds: 20 });
    web = createQueue({ connectionString: own.url, role: "web" });
    await worker.start();
    await web.start();
  });

  afterAll(async () => {
    await web.stop();
    await worker.stop();
    await own.drop();
  });

  it("задача из веба доходит до работника сразу, не дожидаясь опроса", async () => {
    let deliver: (payload: { inboundMessageId: string }) => void = () => {};
    await worker.work("inbound-route", async (payload) => deliver(payload));
    // Первый, пустой забор работника проходит сразу при подключении; ждём, пока он закончится
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const received = waitFor<{ inboundMessageId: string }>((resolve) => (deliver = resolve), 5000);
    await web.enqueue("inbound-route", { inboundMessageId: "in-1" });
    expect(await received).toEqual({ inboundMessageId: "in-1" });
  });
});
