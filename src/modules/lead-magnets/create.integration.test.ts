import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { eq, sql } from "drizzle-orm";
import { createLeadMagnet, getLeadMagnet, listVersions } from "./index";
import { leadMagnets } from "./schema";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe("создание лидмагнита", () => {
  it("повтор той же формы (тот же id) не создаёт вторую карточку", async () => {
    const id = randomUUID();
    const first = await createLeadMagnet(database.db, { id, name: "Разбор воронки" });
    const again = await createLeadMagnet(database.db, { id, name: "Разбор воронки" });

    expect(first.id).toBe(id);
    expect(again).toEqual(first);
    expect(await database.db.select().from(leadMagnets)).toHaveLength(1);
    expect(await listVersions(database.db, id)).toHaveLength(1);
  });
});

describe("черновик старого лидмагнита", () => {
  it("без «Описания клиентов» в базе читается с пустым полем", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Старый лидмагнит" });
    await database.db
      .update(leadMagnets)
      .set({ draft: sql`${leadMagnets.draft} - 'clientPortrait'` })
      .where(eq(leadMagnets.id, lead.id));

    expect((await getLeadMagnet(database.db, lead.id))!.draft.clientPortrait).toBe("");
  });
});
