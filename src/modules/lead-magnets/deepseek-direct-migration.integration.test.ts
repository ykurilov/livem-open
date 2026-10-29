import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { openChatStorage, type AppChatStorage } from "../platform/chat-storage";
import { createLeadMagnet, getLeadMagnet, listVersions } from "./index";

/** Миграция 0032: DeepSeek 4.1 Flash снова у самого DeepSeek, Together — запасной (Дмитрий 22.10). Обратна 0026. */
const MIGRATION = readFileSync(path.join(process.cwd(), "drizzle", "0032_deepseek_flash_direct_again.sql"), "utf8")
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

async function setChoice(id: string, providerId: string, modelId: string) {
  const choice = sql`jsonb_build_object('providerId', ${providerId}::text, 'modelId', ${modelId}::text)`;
  await database.db.execute(sql`update app.lead_magnet_versions set settings = settings || ${choice} where lead_magnet_id = ${id}`);
  await database.db.execute(sql`update app.lead_magnets set draft = draft || ${choice} where id = ${id}`);
}

describe("возврат DeepSeek 4.1 Flash на сам DeepSeek", () => {
  it("Together → DeepSeek в черновике, версиях и чатах; другие модели и провайдеры не трогаются; повтор безопасен", async () => {
    const onDeepseek = await createLeadMagnet(database.db, { name: "На DeepSeek" });
    const otherModel = await createLeadMagnet(database.db, { name: "Другая модель DeepSeek" });
    const onOpenrouter = await createLeadMagnet(database.db, { name: "На OpenRouter" });
    await setChoice(onDeepseek.id, "together", "deepseek-4.1-flash");
    await setChoice(otherModel.id, "together", "deepseek-4.1-pro");
    await setChoice(onOpenrouter.id, "openrouter", "deepseek-4.1-flash");

    const runningChat = randomUUID();
    const otherChat = randomUUID();
    await chatStorage.createChat({ id: runningChat, ownerId: "person", providerId: "together", modelId: "deepseek-4.1-flash" });
    await chatStorage.createChat({ id: otherChat, ownerId: "person", providerId: "together", modelId: "deepseek-4.1-pro" });

    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));
    for (const statement of MIGRATION) await database.db.execute(sql.raw(statement));

    expect((await getLeadMagnet(database.db, onDeepseek.id))!.draft).toMatchObject({ providerId: "deepseek", modelId: "deepseek-4.1-flash" });
    for (const version of await listVersions(database.db, onDeepseek.id)) expect(version.settings).toMatchObject({ providerId: "deepseek" });

    expect((await getLeadMagnet(database.db, otherModel.id))!.draft).toMatchObject({ providerId: "together", modelId: "deepseek-4.1-pro" });
    expect((await getLeadMagnet(database.db, onOpenrouter.id))!.draft).toMatchObject({ providerId: "openrouter" });

    expect(await chatStorage.getChat(runningChat)).toMatchObject({ providerId: "deepseek", modelId: "deepseek-4.1-flash" });
    expect(await chatStorage.getChat(otherChat)).toMatchObject({ providerId: "together" });
  });
});
