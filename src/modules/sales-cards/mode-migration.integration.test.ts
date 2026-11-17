import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet, getLeadMagnet, listVersions } from "../lead-magnets";

/** Миграция 0055: у заготовки вместо «дословно да/нет» — режим из трёх, третий — формула. */
const MIGRATION = readFileSync(path.join(process.cwd(), "drizzle", "0055_sales_card_mode.sql"), "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

const oldCards = [
  { id: "a", stateId: null, title: "Цена", when: "Спросили цену", text: "9 900 ₽", verbatim: true },
  { id: "b", stateId: null, title: "Дорого", when: "Человеку дорого", text: "Есть рассрочка", verbatim: false },
];

async function setCards(id: string, cards: unknown) {
  const value = sql`jsonb_build_object('salesCards', ${JSON.stringify(cards)}::jsonb)`;
  await database.db.execute(sql`update app.lead_magnet_versions set settings = settings || ${value} where lead_magnet_id = ${id}`);
  await database.db.execute(sql`update app.lead_magnets set draft = draft || ${value} where id = ${id}`);
}

describe("режим заготовки вместо «дословно»", () => {
  it("дословно → verbatim, иначе → own_words в черновике и всех версиях; остальное не трогается; повтор безопасен", async () => {
    const withCards = await createLeadMagnet(database.db, { name: "С заготовками" });
    const withoutCards = await createLeadMagnet(database.db, { name: "Без заготовок" });
    await setCards(withCards.id, oldCards);
    await database.db.execute(sql`update app.lead_magnets set draft = draft - 'salesCards' where id = ${withoutCards.id}`);
    const before = (await getLeadMagnet(database.db, withoutCards.id))!.draft;

    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));
    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));

    const expected = [
      { id: "a", stateId: null, title: "Цена", when: "Спросили цену", text: "9 900 ₽", mode: "verbatim" },
      { id: "b", stateId: null, title: "Дорого", when: "Человеку дорого", text: "Есть рассрочка", mode: "own_words" },
    ];
    expect((await getLeadMagnet(database.db, withCards.id))!.draft.salesCards).toEqual(expected);
    for (const version of await listVersions(database.db, withCards.id)) expect(version.settings.salesCards).toEqual(expected);
    expect((await getLeadMagnet(database.db, withoutCards.id))!.draft).toEqual(before);
  });

  it("заготовка уже с режимом остаётся как есть", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Формула" });
    const formula = { id: "f", stateId: null, title: "Разбор", when: "Описал задачу", text: "[задача человека]", mode: "formula" };
    await setCards(lead.id, [formula]);
    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));
    expect((await getLeadMagnet(database.db, lead.id))!.draft.salesCards).toEqual([formula]);
  });
});
