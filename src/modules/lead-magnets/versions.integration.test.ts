import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import {
  DEFAULT_MAX_PERSON_MESSAGES,
  createLeadMagnet,
  getLeadMagnet,
  listLeadMagnetCards,
  listVersions,
  rollbackToVersion,
  saveDraft,
} from "./index";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe("создание лидмагнита", () => {
  it("новый лидмагнит — черновик с настройками по умолчанию и первой версией", async () => {
    const created = await createLeadMagnet(database.db, { name: "Разбор воронки" });
    expect(created.draft.name).toBe("Разбор воронки");
    expect(created.draft.maxPersonMessages).toBe(DEFAULT_MAX_PERSON_MESSAGES);
    expect(DEFAULT_MAX_PERSON_MESSAGES).toBe(60);
    expect(created.draft.stages).toEqual([]);
    expect(created.draft.providerId).toBe("deepseek");
    expect(created.draft.viewsLinks).toBe(false);
    expect(created.draft.modelId).toBe("deepseek-4.1-flash");
    expect(created.publishedSnapshotId).toBeNull();

    const versions = await listVersions(database.db, created.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.id).toBe(created.draftVersionId);
  });

  it("карточки показывают название, описание и статус", async () => {
    const created = await createLeadMagnet(database.db, { name: "Карточка", cardDescription: "Для экспертов" });
    const card = (await listLeadMagnetCards(database.db)).find((candidate) => candidate.id === created.id);
    expect(card).toMatchObject({ name: "Карточка", cardDescription: "Для экспертов", published: false });
  });
});

describe("версии черновика", () => {
  it("каждое сохранение создаёт новую версию со своим источником", async () => {
    const created = await createLeadMagnet(database.db, { name: "Версии" });
    const byConstructor = await saveDraft(database.db, created.id, { ...created.draft, firstMessage: "Привет!" }, "constructor");
    const byExpert = await saveDraft(database.db, created.id, { ...byConstructor.settings, firstMessage: "Здравствуйте!" }, "manual");

    const versions = await listVersions(database.db, created.id);
    expect(versions.map((version) => version.source)).toEqual(["manual", "constructor", "manual"]);
    expect(versions[0]!.id).toBe(byExpert.id);

    const current = await getLeadMagnet(database.db, created.id);
    expect(current?.draft.firstMessage).toBe("Здравствуйте!");
    expect(current?.draftVersionId).toBe(byExpert.id);
  });

  it("версии неизменны: следующее сохранение не трогает прошлую", async () => {
    const created = await createLeadMagnet(database.db, { name: "Неизменность" });
    const first = await saveDraft(database.db, created.id, { ...created.draft, instruction: "Первая" }, "constructor");
    await saveDraft(database.db, created.id, { ...first.settings, instruction: "Вторая" }, "constructor");
    const stored = (await listVersions(database.db, created.id)).find((version) => version.id === first.id);
    expect(stored?.settings.instruction).toBe("Первая");
  });

  it("откат создаёт новую версию «rollback» с настройками выбранной", async () => {
    const created = await createLeadMagnet(database.db, { name: "Откат" });
    const old = await saveDraft(database.db, created.id, { ...created.draft, firstMessage: "Старое" }, "constructor");
    await saveDraft(database.db, created.id, { ...old.settings, firstMessage: "Новое" }, "manual");

    const rolledBack = await rollbackToVersion(database.db, created.id, old.id);
    expect(rolledBack.source).toBe("rollback");
    expect(rolledBack.id).not.toBe(old.id);
    expect(rolledBack.settings.firstMessage).toBe("Старое");

    const current = await getLeadMagnet(database.db, created.id);
    expect(current?.draft.firstMessage).toBe("Старое");
    expect(current?.draftVersionId).toBe(rolledBack.id);
    expect((await listVersions(database.db, created.id))[0]!.source).toBe("rollback");
  });

  it("откат к версии чужого лидмагнита — ошибка", async () => {
    const first = await createLeadMagnet(database.db, { name: "Первый" });
    const second = await createLeadMagnet(database.db, { name: "Второй" });
    await expect(rollbackToVersion(database.db, first.id, second.draftVersionId)).rejects.toThrow();
  });

  it("инструкция этапа длиннее 1500 знаков не сохраняется", async () => {
    const created = await createLeadMagnet(database.db, { name: "Длинный этап" });
    const stage = { id: "s1", name: "Этап", instruction: "я".repeat(1501), transitionCondition: "дальше", startDay: null, isSale: false };
    await expect(saveDraft(database.db, created.id, { ...created.draft, stages: [stage] }, "manual")).rejects.toThrow(/1500/);
    expect(await listVersions(database.db, created.id)).toHaveLength(1);
  });
});
