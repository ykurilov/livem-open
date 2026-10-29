// Рекламные ссылки с метками (US8): код на каждый привязанный мессенджер, архив вместо удаления у метки с людьми
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import {
  archiveEntryLink,
  createLabeledLink,
  deleteEntryLink,
  EntryLinkError,
  findEntryLinkByCode,
  listLabeledLinks,
} from "./links";
import { LeadMagnetNotFoundError } from "./lead-magnets";
import { entryLinks } from "./schema";
import { listPeople, listPeopleFilterOptions, parsePeopleFilter } from "../people";

let database: TestDatabase;
let kit: LiveDialogKit;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
});

async function arriveBy(code: string) {
  const person = `user-${randomUUID().slice(0, 8)}`;
  await kit.send(person, `/start ${code}`, { startCode: code });
  await kit.drain();
  return person;
}

describe("ссылка с меткой", () => {
  it("новая ссылка — свой случайный код и адрес в каждом привязанном мессенджере", async () => {
    const lead = await kit.publish();
    const link = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "  Блогер Маша " });

    expect(link.label).toBe("Блогер Маша");
    expect(link.code).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(link.code).not.toBe(lead.code);

    const listed = await listLabeledLinks(database.db, { telegram: kit.channel }, lead.leadMagnetId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: link.id, label: "Блогер Маша", code: link.code, hasPeople: false });
    expect(listed[0]!.urls).toEqual([{ channel: "telegram", url: `https://fake.test/${kit.bot.username}?start=${link.code}` }]);
  });

  it("пустая метка и повтор действующей метки не создаются", async () => {
    const lead = await kit.publish();
    await expect(createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "   " })).rejects.toThrow(EntryLinkError);
    await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Реклама ВК" });
    await expect(createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "реклама вк" })).rejects.toThrow(
      /уже есть/,
    );
  });

  it("человек по ссылке с меткой — метка записана в его прохождение", async () => {
    const lead = await kit.publish();
    const link = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Блогер Маша" });

    const person = await arriveBy(link.code);

    const [passage] = await kit.passagesOf(person);
    expect(passage).toMatchObject({ leadMagnetId: lead.leadMagnetId, entryLinkId: link.id, status: "active" });
  });

  it("метку без людей можно удалить", async () => {
    const lead = await kit.publish();
    const link = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Пустая" });

    await deleteEntryLink(database.db, link.id);

    expect(await findEntryLinkByCode(database.db, link.code)).toBeNull();
  });

  it("метку с людьми удалить нельзя, только в архив: она скрыта, но ссылка по-прежнему ведёт в лидмагнит", async () => {
    const lead = await kit.publish();
    const link = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Блогер Маша" });
    await arriveBy(link.code);
    expect((await listLabeledLinks(database.db, { telegram: kit.channel }, lead.leadMagnetId))[0]!.hasPeople).toBe(true);

    await expect(deleteEntryLink(database.db, link.id)).rejects.toThrow(/только отправить в архив/);
    await archiveEntryLink(database.db, link.id);

    expect(await listLabeledLinks(database.db, { telegram: kit.channel }, lead.leadMagnetId)).toEqual([]);
    expect((await findEntryLinkByCode(database.db, link.code))?.archivedAt).not.toBeNull();
    const late = await arriveBy(link.code);
    expect((await kit.passagesOf(late))[0]).toMatchObject({ entryLinkId: link.id, status: "active" });

    // Метку из архива можно завести заново под тем же именем
    await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Блогер Маша" });
  });

  it("основную ссылку нельзя ни удалить, ни отправить в архив", async () => {
    const lead = await kit.publish();
    const main = (await findEntryLinkByCode(database.db, lead.code))!;

    await expect(deleteEntryLink(database.db, main.id)).rejects.toThrow(EntryLinkError);
    await expect(archiveEntryLink(database.db, main.id)).rejects.toThrow(EntryLinkError);
  });

  it("чужой или несуществующий id — понятная ошибка", async () => {
    await expect(deleteEntryLink(database.db, "not-a-uuid")).rejects.toThrow(EntryLinkError);
    await expect(archiveEntryLink(database.db, randomUUID())).rejects.toThrow(EntryLinkError);
  });
});

describe("метки после ревью", () => {
  it("база не пускает дубль действующей метки, даже мимо проверки модуля", async () => {
    const lead = await kit.publish();
    await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Реклама ВК" });

    await expect(
      database.db.insert(entryLinks).values({ leadMagnetId: lead.leadMagnetId, code: "DupLabel", label: "реклама вк" }),
    ).rejects.toThrow();
  });

  it("одновременные «Новая ссылка» с одной меткой: создаётся одна, остальным понятная ошибка", async () => {
    const lead = await kit.publish();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Гонка" })),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((entry) => entry.status === "rejected"))
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(EntryLinkError);
  });

  it("чужой или кривой id лидмагнита — LeadMagnetNotFoundError, а не сбой базы", async () => {
    await expect(createLabeledLink(database.db, { leadMagnetId: "кривой", label: "Метка" })).rejects.toBeInstanceOf(LeadMagnetNotFoundError);
    await expect(createLabeledLink(database.db, { leadMagnetId: randomUUID(), label: "Метка" })).rejects.toBeInstanceOf(
      LeadMagnetNotFoundError,
    );
  });

  it("фильтр базы людей по метке находит пришедших по ней", async () => {
    const lead = await kit.publish();
    const link = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Блогер Петя" });
    const byLabel = await arriveBy(link.code);
    await arriveBy(lead.code);

    const options = await listPeopleFilterOptions(database.db);
    expect(options.links).toContainEqual(expect.objectContaining({ id: link.id, label: "Блогер Петя" }));
    const found = await listPeople(database.db, parsePeopleFilter({ linkIds: [link.id] }));
    expect(found.map((person) => person.displayName)).toEqual([`Человек ${byLabel}`]);

    // Метка в архиве остаётся в фильтре: по ней приходили люди
    await archiveEntryLink(database.db, link.id);
    expect((await listPeopleFilterOptions(database.db)).links).toContainEqual(expect.objectContaining({ id: link.id }));
  });
});
