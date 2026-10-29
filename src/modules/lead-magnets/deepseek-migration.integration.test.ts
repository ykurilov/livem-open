import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { openChatStorage, type AppChatStorage } from "../platform/chat-storage";
import { createLeadMagnet, getLeadMagnet, listVersions } from "./index";

/** Миграция 0019: старые лидмагниты и чаты на Together переходят на DeepSeek, переключатель ссылок — выключен. */
const MIGRATION = readFileSync(path.join(process.cwd(), "drizzle", "0019_deepseek_and_link_views.sql"), "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

let database: TestDatabase;
let chatStorage: AppChatStorage;

beforeAll(async () => {
  database = await createTestDatabase();
  chatStorage = await openChatStorage(database.url);
});

afterAll(async () => {
  await chatStorage.close?.();
  await database.drop();
});

async function rewindToOldSettings(id: string, providerId: string, modelId: string) {
  const old = sql`(("settings" - 'viewsLinks') || jsonb_build_object('providerId', ${providerId}::text, 'modelId', ${modelId}::text))`;
  await database.db.execute(sql`update app.lead_magnet_versions set settings = ${old} where lead_magnet_id = ${id}`);
  await database.db.execute(
    sql`update app.lead_magnets set draft = (("draft" - 'viewsLinks') || jsonb_build_object('providerId', ${providerId}::text, 'modelId', ${modelId}::text)) where id = ${id}`,
  );
}

describe("перевод старых лидмагнитов на DeepSeek", () => {
  it("Together + DeepSeek 4.1 Flash → DeepSeek в черновике, версиях и чатах; остальное не трогается; ссылки выключены", async () => {
    const onTogether = await createLeadMagnet(database.db, { name: "Старый на Together" });
    const otherModel = await createLeadMagnet(database.db, { name: "Другая модель" });
    await rewindToOldSettings(onTogether.id, "together", "deepseek-4.1-flash");
    await rewindToOldSettings(otherModel.id, "together", "glm-5.3-flash");

    const oldChat = randomUUID();
    const glmChat = randomUUID();
    await chatStorage.createChat({ id: oldChat, ownerId: "person", providerId: "together", modelId: "deepseek-4.1-flash" });
    await chatStorage.createChat({ id: glmChat, ownerId: "person", providerId: "together", modelId: "glm-5.3-flash" });

    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));
    // Повторный прогон ничего не ломает
    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));

    const migrated = (await getLeadMagnet(database.db, onTogether.id))!;
    expect(migrated.draft).toMatchObject({ providerId: "deepseek", modelId: "deepseek-4.1-flash", viewsLinks: false });
    for (const version of await listVersions(database.db, onTogether.id))
      expect(version.settings).toMatchObject({ providerId: "deepseek", viewsLinks: false });

    const untouched = (await getLeadMagnet(database.db, otherModel.id))!;
    expect(untouched.draft).toMatchObject({ providerId: "together", modelId: "glm-5.3-flash", viewsLinks: false });

    expect(await chatStorage.getChat(oldChat)).toMatchObject({ providerId: "deepseek", modelId: "deepseek-4.1-flash" });
    expect(await chatStorage.getChat(glmChat)).toMatchObject({ providerId: "together" });
  });

  it("включённый переключатель миграция не сбрасывает", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Смотрит ссылки" });
    await database.db.execute(sql`update app.lead_magnets set draft = draft || '{"viewsLinks": true}'::jsonb where id = ${lead.id}`);
    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));
    expect((await getLeadMagnet(database.db, lead.id))!.draft.viewsLinks).toBe(true);
  });
});
