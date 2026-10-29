// Временный сбой базы при старте веба не ломает его до перезапуска: неудачная попытка открытия забывается.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { getChatStorage } from "./chat-storage";
import { getWebQueue } from "./queue";

let database: TestDatabase;
let missingDatabaseUrl: string;
const shared = globalThis as typeof globalThis & { livemWebQueue?: unknown; livemChatStorage?: unknown };
const savedDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
  const url = new URL(database.url);
  url.pathname = `${url.pathname}_missing`;
  missingDatabaseUrl = url.toString();
});

afterAll(async () => {
  await (await (shared.livemWebQueue as ReturnType<typeof getWebQueue> | undefined))?.stop();
  await (await (shared.livemChatStorage as ReturnType<typeof getChatStorage> | undefined))?.close();
  delete shared.livemWebQueue;
  delete shared.livemChatStorage;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  await database.drop();
});

describe("общие ресурсы веб-процесса после временного сбоя базы", () => {
  it("очередь: старт упал → следующий вызов подключается → дальше та же очередь", async () => {
    delete shared.livemWebQueue;
    process.env.DATABASE_URL = missingDatabaseUrl;
    await expect(getWebQueue()).rejects.toThrow();

    process.env.DATABASE_URL = database.url;
    const queue = await getWebQueue();
    expect(await queue.ping()).toBe(true);
    expect(await getWebQueue()).toBe(queue);
  });

  it("хранилище переписок: открытие упало → следующий вызов открывает → дальше то же хранилище", async () => {
    delete shared.livemChatStorage;
    await expect(getChatStorage(missingDatabaseUrl)).rejects.toThrow();

    const storage = await getChatStorage(database.url);
    expect(await getChatStorage(database.url)).toBe(storage);
  });
});
