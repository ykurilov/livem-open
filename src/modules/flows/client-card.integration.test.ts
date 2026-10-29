import { randomUUID } from "node:crypto";
import { factId } from "@ykurilov/agent-chat-flows";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { bots } from "../channels/schema";
import { previewConversations } from "../consultant/schema";
import { createLeadMagnet, setPreviewChat } from "../lead-magnets";
import { createField, deleteField, type FieldDefinition } from "../people";
import { people } from "../people/schema";
import { CABINET_OWNER_ID, previewOwnerId } from "../platform/cabinet-owner";
import { leadMagnetClientCard } from "./client-card";
import { leadMagnetPeople } from "./people";

let database: TestDatabase;
let city: FieldDefinition;
let blogs: FieldDefinition;
let botId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  city = await createField(database.db, { name: "Город", type: "text", description: "Где живёт" });
  blogs = await createField(database.db, { name: "Ведёт блог", type: "boolean", description: "" });
  const [bot] = await database.db
    .insert(bots)
    .values({ channel: "telegram", title: "Бот", externalId: "ext", username: "bot", tokenEncrypted: "x", webhookSecret: "s" })
    .returning();
  botId = bot!.id;
});

afterAll(async () => {
  await database.drop();
});

async function newPerson(extra: Partial<typeof people.$inferInsert> = {}) {
  const [person] = await database.db
    .insert(people)
    .values({ channel: "telegram", botId, externalUserId: randomUUID(), ...extra })
    .returning();
  return person!;
}

async function personRow(id: string) {
  const [row] = await database.db.select().from(people).where(eq(people.id, id));
  return row!;
}

const write = (ownerId: string, fieldId: string, value: unknown, chatId = "chat-1") =>
  leadMagnetClientCard(database.db).write({ ownerId, fieldId, value, chatId, flowId: "lm-1", at: new Date("2026-10-14T10:00:00Z") });

describe("карточка клиента сценария в «Базе»", () => {
  it("поле пишется в карточку человека и читается обратно", async () => {
    const person = await newPerson();
    await write(person.id, city.id, "Тбилиси");
    await write(person.id, blogs.id, true);
    expect((await personRow(person.id)).fieldValues).toEqual({ [city.id]: "Тбилиси", [blogs.id]: true });
    const entries = await leadMagnetClientCard(database.db).read(person.id);
    expect(entries.map(({ fieldId, value }) => ({ fieldId, value }))).toEqual(
      expect.arrayContaining([
        { fieldId: city.id, value: "Тбилиси" },
        { fieldId: blogs.id, value: true },
      ]),
    );
  });

  it("значение не того типа и удалённое поле не пишутся: агент услышит ошибку", async () => {
    const person = await newPerson();
    await expect(write(person.id, blogs.id, "да")).rejects.toThrow(/Ведёт блог/);
    const gone = await createField(database.db, { name: "Удалённое", type: "text", description: "" });
    await deleteField(database.db, gone.id, new Date());
    await expect(write(person.id, gone.id, "x")).rejects.toThrow();
    expect((await personRow(person.id)).fieldValues).toEqual({});
  });

  it("«забудь» стирает одно поле или всё, факты тоже", async () => {
    const card = leadMagnetClientCard(database.db);
    const person = await newPerson();
    await write(person.id, city.id, "Тбилиси");
    await write(person.id, blogs.id, false);
    await card.forget(person.id, city.id);
    expect((await personRow(person.id)).fieldValues).toEqual({ [blogs.id]: false });
    await card.facts!.add({ ownerId: person.id, fact: { id: factId("Пишет книгу"), text: "Пишет книгу" }, chatId: "c", flowId: "f", at: new Date() });
    await card.forget(person.id, "all");
    await card.facts!.forget(person.id, "all");
    const row = await personRow(person.id);
    expect(row.fieldValues).toEqual({});
    expect(row.facts).toEqual([]);
  });

  it("свободные факты — в факты человека, тот же id дважды не пишется, старые факты читаются с id по тексту", async () => {
    const facts = leadMagnetClientCard(database.db).facts!;
    const person = await newPerson({ facts: [{ text: "Живёт в Казани", at: "2026-10-01T10:00:00.000Z", source: "old-passage" }] });
    const fact = { id: factId("Ведёт блог про акварель"), text: "Ведёт блог про акварель" };
    await facts.add({ ownerId: person.id, fact, chatId: "chat-9", flowId: "lm-9", at: new Date("2026-10-14T10:00:00Z") });
    await facts.add({ ownerId: person.id, fact, chatId: "chat-9", flowId: "lm-9", at: new Date("2026-10-14T11:00:00Z") });

    const read = await facts.read(person.id);
    expect(read.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: factId("Живёт в Казани"), text: "Живёт в Казани" },
      fact,
    ]);
    expect((await personRow(person.id)).facts).toHaveLength(2);

    await facts.forget(person.id, factId("Живёт в Казани"));
    expect((await facts.read(person.id)).map((item) => item.text)).toEqual(["Ведёт блог про акварель"]);
  });

  it("тестовый чат пишет в свой тестовый разговор, а не в «Базу»", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Превью" });
    const chatId = randomUUID();
    await database.db.insert(previewConversations).values({ chatId, leadMagnetId: lead.id });
    await setPreviewChat(database.db, lead.id, chatId);
    const card = leadMagnetClientCard(database.db);

    // У нового тестового чата свой владелец, у старого — общий владелец кабинета; карточка у них одна
    await write(previewOwnerId(chatId), city.id, "Сочи", chatId);
    await card.facts!.add({ ownerId: previewOwnerId(chatId), fact: { id: factId("Любит кофе"), text: "Любит кофе" }, chatId, flowId: lead.id, at: new Date() });

    const [preview] = await database.db.select().from(previewConversations).where(eq(previewConversations.chatId, chatId));
    expect(preview!.fieldValues).toEqual({ [city.id]: "Сочи" });
    expect(preview!.facts).toEqual(["Любит кофе"]);
    expect((await card.read(CABINET_OWNER_ID)).map(({ fieldId, value }) => ({ fieldId, value }))).toEqual([{ fieldId: city.id, value: "Сочи" }]);
    expect((await card.facts!.read(CABINET_OWNER_ID)).map((fact) => fact.text)).toEqual(["Любит кофе"]);
    expect((await card.facts!.read(previewOwnerId(randomUUID()))).map((fact) => fact.text)).toEqual(["Любит кофе"]);

    await card.forget(CABINET_OWNER_ID, "all");
    await card.facts!.forget(CABINET_OWNER_ID, "all");
    const [cleared] = await database.db.select().from(previewConversations).where(eq(previewConversations.chatId, chatId));
    expect(cleared!.fieldValues).toEqual({});
    expect(cleared!.facts).toEqual([]);
  });
});

describe("пояс человека сценария", () => {
  it("читается и пишется в карточку человека", async () => {
    const zones = leadMagnetPeople(database.db);
    const person = await newPerson();
    expect(await zones.readTimeZone(person.id)).toBeNull();
    await zones.writeTimeZone(person.id, "Asia/Novosibirsk");
    expect((await personRow(person.id)).timeZone).toBe("Asia/Novosibirsk");
    expect(await zones.readTimeZone(person.id)).toBe("Asia/Novosibirsk");
  });

  it("у тестового чата — в тестовом разговоре", async () => {
    const zones = leadMagnetPeople(database.db);
    const lead = await createLeadMagnet(database.db, { name: "Превью пояса" });
    const chatId = randomUUID();
    await database.db.insert(previewConversations).values({ chatId, leadMagnetId: lead.id });
    await setPreviewChat(database.db, lead.id, chatId);
    await zones.writeTimeZone(CABINET_OWNER_ID, "Europe/Kaliningrad");
    const [preview] = await database.db.select().from(previewConversations).where(eq(previewConversations.chatId, chatId));
    expect(preview!.timeZone).toBe("Europe/Kaliningrad");
    expect(await zones.readTimeZone(CABINET_OWNER_ID)).toBe("Europe/Kaliningrad");
  });
});
