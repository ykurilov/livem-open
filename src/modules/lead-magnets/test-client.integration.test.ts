import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { TEST_CLIENT_MAX_CHARS, TestClientTooLongError, createLeadMagnet, getLeadMagnet, listVersions, saveDraft, setPreviewChat, setTestClient } from "./index";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe("«Клиент для проверки»", () => {
  it("у нового лидмагнита описания нет", async () => {
    const created = await createLeadMagnet(database.db, { name: "Разбор воронки" });
    expect(created.testClient).toBeNull();
  });

  it("сохраняется без лишних пробелов, пустое — как его нет", async () => {
    const created = await createLeadMagnet(database.db, { name: "Разбор воронки" });
    await setTestClient(database.db, created.id, "  Мама двоих детей, сомневается в цене.  ");
    expect((await getLeadMagnet(database.db, created.id))?.testClient).toBe("Мама двоих детей, сомневается в цене.");
    await setTestClient(database.db, created.id, "   ");
    expect((await getLeadMagnet(database.db, created.id))?.testClient).toBeNull();
  });

  it("не попадает в черновик и версии, переживает сохранение черновика и новый тестовый разговор", async () => {
    const created = await createLeadMagnet(database.db, { name: "Разбор воронки" });
    await setTestClient(database.db, created.id, "Студент без денег");
    await saveDraft(database.db, created.id, { ...created.draft, cardDescription: "Новое" }, "manual");
    await setPreviewChat(database.db, created.id, "preview-new-chat");
    const lead = (await getLeadMagnet(database.db, created.id))!;
    expect(lead.testClient).toBe("Студент без денег");
    expect(JSON.stringify(lead.draft)).not.toContain("Студент без денег");
    for (const version of await listVersions(database.db, created.id)) expect(JSON.stringify(version.settings)).not.toContain("Студент без денег");
  });

  it("длиннее предела не сохраняется, прежнее описание остаётся; ровно предел — сохраняется", async () => {
    const created = await createLeadMagnet(database.db, { name: "Разбор воронки" });
    await setTestClient(database.db, created.id, "Студент");
    await expect(setTestClient(database.db, created.id, "а".repeat(TEST_CLIENT_MAX_CHARS + 1))).rejects.toThrow(TestClientTooLongError);
    expect((await getLeadMagnet(database.db, created.id))?.testClient).toBe("Студент");
    await setTestClient(database.db, created.id, `  ${"а".repeat(TEST_CLIENT_MAX_CHARS)}  `);
    expect((await getLeadMagnet(database.db, created.id))?.testClient).toHaveLength(TEST_CLIENT_MAX_CHARS);
  });
});
