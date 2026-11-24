// Перенос единственного чата конструктора (lead_magnets.constructor_chat_id) в список чатов лидмагнита
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { MIGRATIONS_FOLDER, migrateDatabase } from "../platform/db";

const MIGRATION_TAG = "0062_constructor_chats";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await database.drop();
});

/** Папка миграций до переноса: без миграции списка чатов и всех следующих — иначе более поздняя запись в журнале закроет её. */
async function migrationsBefore(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "migrations-before-"));
  await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  expect(journal.entries.some((entry) => entry.tag === MIGRATION_TAG)).toBe(true);
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG));
  await writeFile(journalPath, JSON.stringify(journal));
  return folder;
}

describe("миграция списка чатов конструктора", () => {
  it("прежний чат каждого лидмагнита становится первым в его списке; лидмагнит без чата остаётся без чатов", async () => {
    await migrateDatabase(database, await migrationsBefore());
    const { rows } = await database.pool.query<{ id: string }>(
      `insert into app.lead_magnets (draft, constructor_chat_id) values ('{}'::jsonb, 'old-chat-a'), ('{}'::jsonb, 'old-chat-b'), ('{}'::jsonb, null)
       returning id`,
    );
    const [a, b, empty] = rows.map((row) => row.id);

    await migrateDatabase(database);

    const { rows: chats } = await database.pool.query<{ chat_id: string; lead_magnet_id: string }>(
      "select chat_id, lead_magnet_id from app.constructor_chats order by chat_id",
    );
    expect(chats).toEqual([
      { chat_id: "old-chat-a", lead_magnet_id: a },
      { chat_id: "old-chat-b", lead_magnet_id: b },
    ]);
    expect(chats.some((chat) => chat.lead_magnet_id === empty)).toBe(false);
  });
});
