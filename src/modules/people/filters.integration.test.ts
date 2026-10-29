import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { bots } from "../channels/schema";
import { passages, type PassageStatus } from "../conversations/schema";
import { createLeadMagnet, saveDraft } from "../lead-magnets";
import { entryLinks } from "../lead-magnets/schema";
import { createField } from "./fields";
import { InvalidPeopleFilterError, countPeople, listPeople, parsePeopleFilter, type PeopleFilter } from "./filters";
import { people, type PersonFieldValue } from "./schema";

let database: TestDatabase;

// Мир теста: два бота, два лидмагнита, у первого — основная ссылка и ссылка с меткой «vk-ads»
const world = {
  telegramBot: "",
  vkBot: "",
  courseLead: "",
  webinarLead: "",
  mainLink: "",
  adsLink: "",
  hasCourse: "",
  niche: "",
  students: "",
  about: "",
};
const person: Record<"anna" | "boris" | "vera" | "gleb", string> = { anna: "", boris: "", vera: "", gleb: "" };

async function addBot(channel: "telegram" | "vk") {
  const tag = randomUUID().slice(0, 8);
  const [bot] = await database.db
    .insert(bots)
    .values({ channel, title: `Бот ${tag}`, externalId: tag, username: `bot_${tag}`, tokenEncrypted: "x", webhookSecret: tag })
    .returning();
  return bot!.id;
}

async function addLead(name: string) {
  const lead = await createLeadMagnet(database.db, { name });
  const version = await saveDraft(database.db, lead.id, { ...lead.draft, name }, "manual");
  return { id: lead.id, snapshotId: version.id };
}

async function addPerson(botId: string, name: string, fieldValues: Record<string, PersonFieldValue> = {}) {
  const [row] = await database.db
    .insert(people)
    .values({ channel: "telegram", botId, externalUserId: randomUUID(), displayName: name, fieldValues })
    .returning();
  return row!.id;
}

async function addPassage(personId: string, lead: { id: string; snapshotId: string }, status: PassageStatus, entryLinkId: string | null) {
  await database.db.insert(passages).values({
    personId,
    leadMagnetId: lead.id,
    snapshotId: lead.snapshotId,
    entryLinkId,
    chatId: `chat-${randomUUID()}`,
    status,
  });
}

const found = async (filter: PeopleFilter) => {
  const rows = await listPeople(database.db, filter);
  return rows.map((row) => row.id).sort();
};
const ids = (...names: Array<keyof typeof person>) => names.map((name) => person[name]).sort();

beforeAll(async () => {
  database = await createTestDatabase();
  world.telegramBot = await addBot("telegram");
  world.vkBot = await addBot("vk");
  const course = await addLead("Курс за неделю");
  const webinar = await addLead("Вебинар");
  world.courseLead = course.id;
  world.webinarLead = webinar.id;
  const [main] = await database.db.insert(entryLinks).values({ leadMagnetId: course.id, code: "MAINLINK" }).returning();
  const [ads] = await database.db.insert(entryLinks).values({ leadMagnetId: course.id, code: "ADSLINK1", label: "vk-ads" }).returning();
  world.mainLink = main!.id;
  world.adsLink = ads!.id;

  world.hasCourse = (await createField(database.db, { name: "Есть свой курс", type: "boolean", description: "" })).id;
  world.niche = (
    await createField(database.db, { name: "Ниша", type: "choice", options: ["Психология", "Дизайн", "Фитнес"], description: "" })
  ).id;
  world.students = (await createField(database.db, { name: "Учеников", type: "number", description: "" })).id;
  world.about = (await createField(database.db, { name: "О себе", type: "text", description: "" })).id;

  // Анна: курс по рекламной ссылке, завершила; вебинар идёт
  person.anna = await addPerson(world.telegramBot, "Анна", {
    [world.hasCourse]: true,
    [world.niche]: "Психология",
    [world.students]: 120,
    [world.about]: "Веду группы по выходным",
  });
  await addPassage(person.anna, course, "completed", world.adsLink);
  await addPassage(person.anna, webinar, "active", null);

  // Борис: курс по основной ссылке, не завершил
  person.boris = await addPerson(world.telegramBot, "Борис", {
    [world.hasCourse]: false,
    [world.niche]: "Дизайн",
    // Число строкой — не число: условия «больше/меньше» его не берут
    [world.students]: "40",
  });
  await addPassage(person.boris, course, "not_completed", world.mainLink);

  // Вера: другой бот, вебинар завершила
  person.vera = await addPerson(world.vkBot, "Вера", { [world.niche]: "Фитнес", [world.students]: 15, [world.about]: "Тренер, ГРУППЫ онлайн" });
  await addPassage(person.vera, webinar, "completed", null);

  // Глеб: заблокировал бота посреди курса
  person.gleb = await addPerson(world.telegramBot, "Глеб");
  await addPassage(person.gleb, course, "blocked", world.mainLink);
});

afterAll(async () => {
  await database.drop();
});

describe("фильтры базы", () => {
  it("пустой фильтр — вся база; число совпадает со списком", async () => {
    expect(await found({})).toEqual(ids("anna", "boris", "vera", "gleb"));
    expect(await countPeople(database.db, {})).toBe(4);
  });

  it("по боту", async () => {
    expect(await found({ botIds: [world.vkBot] })).toEqual(ids("vera"));
    expect(await countPeople(database.db, { botIds: [world.telegramBot] })).toBe(3);
  });

  it("по лидмагниту: человек с двумя прохождениями — одна запись", async () => {
    expect(await found({ leadMagnetIds: [world.webinarLead] })).toEqual(ids("anna", "vera"));
    expect(await countPeople(database.db, { leadMagnetIds: [world.courseLead, world.webinarLead] })).toBe(4);
  });

  it("по метке ссылки", async () => {
    expect(await found({ linkIds: [world.adsLink] })).toEqual(ids("anna"));
    expect(await found({ linkIds: [world.mainLink] })).toEqual(ids("boris", "gleb"));
  });

  it("по статусу прохождения", async () => {
    expect(await found({ statuses: ["completed"] })).toEqual(ids("anna", "vera"));
    expect(await found({ statuses: ["blocked", "not_completed"] })).toEqual(ids("boris", "gleb"));
  });

  it("лидмагнит, метка и статус относятся к одному прохождению", async () => {
    // Анна завершила курс, а не вебинар; вебинар у неё идёт
    expect(await found({ leadMagnetIds: [world.webinarLead], statuses: ["completed"] })).toEqual(ids("vera"));
    expect(await found({ leadMagnetIds: [world.courseLead], statuses: ["completed"] })).toEqual(ids("anna"));
  });

  it("без идущего прохождения — для рассылок", async () => {
    expect(await found({ withoutActivePassage: true })).toEqual(ids("boris", "vera", "gleb"));
  });

  it("поле да/нет", async () => {
    expect(await found({ fieldConditions: [{ fieldId: world.hasCourse, kind: "boolean", equals: true }] })).toEqual(ids("anna"));
    expect(await found({ fieldConditions: [{ fieldId: world.hasCourse, kind: "boolean", equals: false }] })).toEqual(ids("boris"));
  });

  it("поле с выбором — любой из вариантов", async () => {
    expect(
      await found({ fieldConditions: [{ fieldId: world.niche, kind: "choice", anyOf: ["Психология", "Фитнес"] }] }),
    ).toEqual(ids("anna", "vera"));
  });

  it("числовое поле — от и до; число строкой не подходит", async () => {
    expect(await found({ fieldConditions: [{ fieldId: world.students, kind: "number", min: 20 }] })).toEqual(ids("anna"));
    expect(await found({ fieldConditions: [{ fieldId: world.students, kind: "number", max: 100 }] })).toEqual(ids("vera"));
    expect(await found({ fieldConditions: [{ fieldId: world.students, kind: "number", min: 10, max: 200 }] })).toEqual(
      ids("anna", "vera"),
    );
  });

  it("текстовое поле — содержит, без учёта регистра", async () => {
    expect(await found({ fieldConditions: [{ fieldId: world.about, kind: "text", contains: "группы" }] })).toEqual(
      ids("anna", "vera"),
    );
  });

  it("несколько условий — все сразу, вместе с ботом", async () => {
    const filter: PeopleFilter = {
      botIds: [world.telegramBot],
      fieldConditions: [
        { fieldId: world.niche, kind: "choice", anyOf: ["Психология", "Фитнес"] },
        { fieldId: world.students, kind: "number", min: 100 },
      ],
    };
    expect(await found(filter)).toEqual(ids("anna"));
    expect(await countPeople(database.db, filter)).toBe(1);
  });

  it("строка списка: имя, бот и последнее прохождение", async () => {
    const [anna] = await listPeople(database.db, { linkIds: [world.adsLink] });
    expect(anna).toMatchObject({
      id: person.anna,
      displayName: "Анна",
      channel: "telegram",
      lastPassage: { leadMagnetName: "Вебинар", status: "active" },
    });
    expect(anna!.botTitle).toMatch(/^Бот /);
  });

  it("список постранично", async () => {
    const first = await listPeople(database.db, {}, { limit: 3, offset: 0 });
    const rest = await listPeople(database.db, {}, { limit: 3, offset: 3 });
    expect(first).toHaveLength(3);
    expect(rest).toHaveLength(1);
    expect(new Set([...first, ...rest].map((row) => row.id)).size).toBe(4);
  });
});

describe("разбор фильтра (общий с рассылками)", () => {
  it("принимает сохранённый фильтр и отбрасывает пустые списки", () => {
    expect(
      parsePeopleFilter({ botIds: [], statuses: ["completed"], fieldConditions: [{ fieldId: world.hasCourse || randomUUID(), kind: "boolean", equals: true }] }),
    ).toEqual({ statuses: ["completed"], fieldConditions: [{ fieldId: expect.any(String), kind: "boolean", equals: true }] });
  });

  it("отклоняет неизвестный статус, тип условия и пустой диапазон", () => {
    expect(() => parsePeopleFilter({ statuses: ["lost"] })).toThrow(InvalidPeopleFilterError);
    expect(() => parsePeopleFilter({ fieldConditions: [{ fieldId: randomUUID(), kind: "date" }] })).toThrow(InvalidPeopleFilterError);
    expect(() => parsePeopleFilter({ fieldConditions: [{ fieldId: randomUUID(), kind: "number", min: 10, max: 5 }] })).toThrow(
      InvalidPeopleFilterError,
    );
    expect(() => parsePeopleFilter({ fieldConditions: [{ fieldId: randomUUID(), kind: "choice", anyOf: [] }] })).toThrow(
      InvalidPeopleFilterError,
    );
  });
});
