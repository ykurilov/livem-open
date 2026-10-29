import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet, getLeadMagnet, listVersions, validateLeadMagnetSettings } from "./index";

/** Миграция 0020: колонки программы и нули в старых настройках. Колонки уже созданы миграциями тестовой базы — повторяем только правки jsonb. */
const MIGRATION = readFileSync(path.join(process.cwd(), "drizzle", "0020_multi_day_program.sql"), "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => /^UPDATE\b/im.test(statement.replace(/^(--.*\n)+/gm, "").trim()));

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

/** Приводит черновик и все версии к виду «до программы»: без `program` и без `startDay`/`isSale` у этапов. */
async function rewindToOldSettings(id: string) {
  const oldStages = JSON.stringify([
    { id: "hello", name: "Знакомство", instruction: "Познакомься", transitionCondition: "Назвал цель" },
    { id: "practice", name: "Практика", instruction: "", transitionCondition: "" },
  ]);
  await database.db.execute(
    sql`update app.lead_magnets set draft = (("draft" - 'program') || jsonb_build_object('stages', ${oldStages}::jsonb)) where id = ${id}`,
  );
  await database.db.execute(
    sql`update app.lead_magnet_versions set settings = (("settings" - 'program') || jsonb_build_object('stages', ${oldStages}::jsonb)) where lead_magnet_id = ${id}`,
  );
}

describe("миграция 0020: многодневная программа", () => {
  it("новые колонки на месте, у старых строк значения по умолчанию", async () => {
    const columns = await database.db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'app' and (
        (table_name = 'passages' and column_name in ('program_start_date', 'day_message_count', 'day_message_count_day', 'day_closed_notice_day', 'outreach_sent_count', 'outreach_day', 'furthest_day', 'sale_answer', 'side_tasks'))
        or (table_name = 'people' and column_name = 'time_zone')
        or (table_name = 'preview_conversations' and column_name = 'day_offset'))`);
    const found = columns.rows.map((row) => `${row.table_name}.${row.column_name}`).sort();
    expect(found).toEqual(
      [
        "passages.day_closed_notice_day",
        "passages.day_message_count",
        "passages.day_message_count_day",
        "passages.furthest_day",
        "passages.outreach_day",
        "passages.outreach_sent_count",
        "passages.program_start_date",
        "passages.sale_answer",
        "passages.side_tasks",
        "people.time_zone",
        "preview_conversations.day_offset",
      ].sort(),
    );
  });

  it("старый черновик и все версии читаются и проходят проверку: программы нет, у этапов нет дня и «Продажи»", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Старый лидмагнит" });
    await rewindToOldSettings(lead.id);
    const before = await database.db.execute<{ has_program: boolean }>(sql`select draft ? 'program' as has_program from app.lead_magnets where id = ${lead.id}`);
    expect(before.rows[0]!.has_program).toBe(false);

    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));
    // Повторный прогон ничего не ломает
    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));

    const migrated = (await getLeadMagnet(database.db, lead.id))!;
    expect(migrated.draft.program).toBeNull();
    expect(migrated.draft.stages).toEqual([
      { id: "hello", name: "Знакомство", instruction: "Познакомься", transitionCondition: "Назвал цель", startDay: null, isSale: false },
      { id: "practice", name: "Практика", instruction: "", transitionCondition: "", startDay: null, isSale: false },
    ]);
    expect(() => validateLeadMagnetSettings(migrated.draft)).not.toThrow();

    const versions = await listVersions(database.db, lead.id);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(version.settings.program).toBeNull();
      expect(version.settings.stages.map((stage) => [stage.startDay, stage.isSale])).toEqual([
        [null, false],
        [null, false],
      ]);
      expect(() => validateLeadMagnetSettings(version.settings)).not.toThrow();
    }
  });

  it("порядок этапов сохраняется, а уже заданные день и «Продажа» миграция не стирает", async () => {
    const lead = await createLeadMagnet(database.db, { name: "С программой" });
    const stages = JSON.stringify([
      { id: "a", name: "А", instruction: "", transitionCondition: "" },
      { id: "b", name: "Б", instruction: "", transitionCondition: "", startDay: 2 },
      { id: "c", name: "В", instruction: "", transitionCondition: "", startDay: 3, isSale: true },
      { id: "d", name: "Г", instruction: "", transitionCondition: "" },
    ]);
    await database.db.execute(
      sql`update app.lead_magnets set draft = (draft || jsonb_build_object('stages', ${stages}::jsonb, 'program', jsonb_build_object('days', 3))) where id = ${lead.id}`,
    );
    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));

    const { draft } = (await getLeadMagnet(database.db, lead.id))!;
    expect(draft.stages.map((stage) => [stage.id, stage.startDay, stage.isSale])).toEqual([
      ["a", null, false],
      ["b", 2, false],
      ["c", 3, true],
      ["d", null, false],
    ]);
    expect(draft.program).toMatchObject({ days: 3 });
  });

  it("лидмагнит без этапов тоже получает program: null", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Пустой" });
    await database.db.execute(sql`update app.lead_magnets set draft = ("draft" - 'program') where id = ${lead.id}`);
    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));
    const { draft } = (await getLeadMagnet(database.db, lead.id))!;
    expect(draft.program).toBeNull();
    expect(draft.stages).toEqual([]);
  });
});
