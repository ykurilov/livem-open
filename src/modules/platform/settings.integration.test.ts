import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { readSettings, updateSettings } from "./settings";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe("настройки приложения", () => {
  it("при первом чтении создаёт строку с настройками по умолчанию", async () => {
    const settings = await readSettings(database.db);
    expect(settings.dailyLimitUsd).toBe("1.000000");
    expect(settings.maxMessageChars).toBe(2000);
    expect(settings.monthlyBudgetUsd).toBeNull();
  });

  it("повторное чтение не создаёт вторую строку", async () => {
    await readSettings(database.db);
    const rows = await database.pool.query("select count(*)::int as n from app.app_settings");
    expect(rows.rows[0].n).toBe(1);
  });

  it("обновляет только переданные поля", async () => {
    await updateSettings(database.db, { monthlyBudgetUsd: "25", alertChatId: "123" });
    const settings = await readSettings(database.db);
    expect(settings.monthlyBudgetUsd).toBe("25.000000");
    expect(settings.alertChatId).toBe("123");
    expect(settings.dailyLimitUsd).toBe("1.000000");
  });

  it("обновление до первого чтения тоже работает", async () => {
    const fresh = await createTestDatabase();
    try {
      await updateSettings(fresh.db, { privacyPolicyUrl: "https://example.com/privacy" });
      expect((await readSettings(fresh.db)).privacyPolicyUrl).toBe("https://example.com/privacy");
    } finally {
      await fresh.drop();
    }
  });
});
