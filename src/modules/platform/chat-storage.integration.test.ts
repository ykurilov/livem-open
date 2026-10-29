import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { getRunningAnswerRegistry, openChatStorage } from "./chat-storage";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await database.drop();
});

describe("хранилище переписок", () => {
  it("при открытии создаёт схему agent_chat", async () => {
    const storage = await openChatStorage(database.url);
    try {
      const result = await database.pool.query(
        "select 1 from information_schema.schemata where schema_name = 'agent_chat'",
      );
      expect(result.rowCount).toBe(1);
    } finally {
      await storage.close();
    }
  });

  it("реестр идущих ответов один на процесс", () => {
    expect(getRunningAnswerRegistry()).toBe(getRunningAnswerRegistry());
  });
});
