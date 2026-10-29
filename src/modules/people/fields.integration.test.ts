import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { bots } from "../channels/schema";
import { InvalidFieldError, createField, deleteField, getFields, listFields, renameField } from "./fields";
import { getPerson, rememberAboutPerson } from "./people";
import { fields, people } from "./schema";

let database: TestDatabase;
let botId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  const [bot] = await database.db
    .insert(bots)
    .values({ channel: "telegram", title: "Бот", externalId: "1", username: "bot", tokenEncrypted: "x", webhookSecret: "s" })
    .returning();
  botId = bot!.id;
});

afterAll(async () => {
  await database.drop();
});

async function addPerson() {
  const [row] = await database.db
    .insert(people)
    .values({ channel: "telegram", botId, externalUserId: randomUUID() })
    .returning();
  return row!.id;
}

const unique = (name: string) => `${name} ${randomUUID().slice(0, 6)}`;
const at = new Date("2026-10-02T12:00:00Z");

describe("удаление поля", () => {
  it("значения уходят в свободные факты «<поле>: <значение>», поле помечено удалённым", async () => {
    const hasCourse = await createField(database.db, { name: unique("Есть свой курс"), type: "boolean", description: "" });
    const students = await createField(database.db, { name: unique("Учеников"), type: "number", description: "" });
    const withCourse = await addPerson();
    const withoutCourse = await addPerson();
    const untouched = await addPerson();
    await rememberAboutPerson(database.db, withCourse, {
      facts: ["Ведёт блог"],
      fieldValues: { [hasCourse.id]: true, [students.id]: 120 },
      source: "passage-1",
      at,
    });
    await rememberAboutPerson(database.db, withoutCourse, { facts: [], fieldValues: { [hasCourse.id]: false }, source: "passage-2", at });

    await deleteField(database.db, hasCourse.id, new Date("2026-10-03T08:00:00Z"));

    const first = await getPerson(database.db, withCourse);
    expect(first!.fieldValues).toEqual({ [students.id]: 120 });
    expect(first!.facts.map((fact) => fact.text)).toEqual(["Ведёт блог", `${hasCourse.name}: да`]);
    expect(first!.facts[1]).toMatchObject({ source: `field:${hasCourse.id}`, at: "2026-10-03T08:00:00.000Z" });

    const second = await getPerson(database.db, withoutCourse);
    expect(second!.fieldValues).toEqual({});
    expect(second!.facts.map((fact) => fact.text)).toEqual([`${hasCourse.name}: нет`]);

    const third = await getPerson(database.db, untouched);
    expect(third!.facts).toEqual([]);

    const [row] = await database.db.select().from(fields).where(eq(fields.id, hasCourse.id));
    expect(row!.deletedAt).toEqual(new Date("2026-10-03T08:00:00Z"));
    expect((await listFields(database.db)).map((field) => field.id)).not.toContain(hasCourse.id);
    expect(await getFields(database.db, [hasCourse.id, students.id])).toEqual([students]);
  });

  it("число, выбор и текст переходят в факты как есть", async () => {
    const students = await createField(database.db, { name: unique("Учеников"), type: "number", description: "" });
    const niche = await createField(database.db, { name: unique("Ниша"), type: "choice", options: ["Дизайн", "Фитнес"], description: "" });
    const about = await createField(database.db, { name: unique("О себе"), type: "text", description: "" });
    const personId = await addPerson();
    await rememberAboutPerson(database.db, personId, {
      facts: [],
      fieldValues: { [students.id]: 1.5, [niche.id]: "Фитнес", [about.id]: "Тренер" },
      source: "passage-3",
      at,
    });

    await deleteField(database.db, students.id, at);
    await deleteField(database.db, niche.id, at);
    await deleteField(database.db, about.id, at);

    const person = await getPerson(database.db, personId);
    expect(person!.fieldValues).toEqual({});
    expect(person!.facts.map((fact) => fact.text)).toEqual([`${students.name}: 1.5`, `${niche.name}: Фитнес`, `${about.name}: Тренер`]);
  });

  it("повторное удаление ничего не меняет; имя удалённого поля снова свободно", async () => {
    const name = unique("Город");
    const city = await createField(database.db, { name, type: "text", description: "" });
    const personId = await addPerson();
    await rememberAboutPerson(database.db, personId, { facts: [], fieldValues: { [city.id]: "Казань" }, source: "p", at });

    await deleteField(database.db, city.id, at);
    await deleteField(database.db, city.id, new Date("2026-10-04T00:00:00Z"));

    const person = await getPerson(database.db, personId);
    expect(person!.facts.map((fact) => fact.text)).toEqual([`${name}: Казань`]);
    const [row] = await database.db.select().from(fields).where(eq(fields.id, city.id));
    expect(row!.deletedAt).toEqual(at);
    await expect(createField(database.db, { name, type: "text", description: "" })).resolves.toMatchObject({ name });
  });

  it("неизвестное поле — ошибка", async () => {
    await expect(deleteField(database.db, randomUUID(), at)).rejects.toThrow(InvalidFieldError);
  });
});

describe("переименование поля", () => {
  it("меняет имя, значения у людей остаются", async () => {
    const field = await createField(database.db, { name: unique("Курс"), type: "boolean", description: "" });
    const personId = await addPerson();
    await rememberAboutPerson(database.db, personId, { facts: [], fieldValues: { [field.id]: true }, source: "p", at });

    const newName = unique("Есть курс");
    const renamed = await renameField(database.db, field.id, `  ${newName}  `);

    expect(renamed).toMatchObject({ id: field.id, name: newName, type: "boolean" });
    expect((await getFields(database.db, [field.id]))[0]!.name).toBe(newName);
    expect((await getPerson(database.db, personId))!.fieldValues).toEqual({ [field.id]: true });
  });

  it("имя занято другим полем (без учёта регистра) или пустое — ошибка", async () => {
    const taken = await createField(database.db, { name: unique("Доход"), type: "number", description: "" });
    const field = await createField(database.db, { name: unique("Выручка"), type: "number", description: "" });

    await expect(renameField(database.db, field.id, taken.name.toUpperCase())).rejects.toThrow(InvalidFieldError);
    await expect(renameField(database.db, field.id, "   ")).rejects.toThrow(InvalidFieldError);
    // Своё же имя в другом регистре — можно
    await expect(renameField(database.db, field.id, field.name.toLowerCase())).resolves.toMatchObject({ name: field.name.toLowerCase() });
  });

  it("удалённое поле не переименовать", async () => {
    const field = await createField(database.db, { name: unique("Старое"), type: "text", description: "" });
    await deleteField(database.db, field.id, at);
    await expect(renameField(database.db, field.id, unique("Новое"))).rejects.toThrow(InvalidFieldError);
  });
});
