import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { checkDatabase } from "./health";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await database.drop();
});

describe("проверка базы для /api/health", () => {
  it("живая база отвечает", async () => {
    expect(await checkDatabase(database)).toBe(true);
  });

  it("закрытое соединение — не отвечает", async () => {
    const closed = await createTestDatabase({ migrate: false });
    await closed.close();
    expect(await checkDatabase(closed)).toBe(false);
    await closed.drop().catch(() => undefined);
  });
});
