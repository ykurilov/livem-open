import { eq } from "drizzle-orm";
import type { Database } from "./db";
import { appSettings } from "./schema";

export type AppSettings = typeof appSettings.$inferSelect;
export type AppSettingsChanges = Partial<Omit<typeof appSettings.$inferInsert, "id">>;

const SETTINGS_ROW_ID = 1;

async function ensureSettingsRow(db: Database): Promise<void> {
  await db
    .insert(appSettings)
    .values({ id: SETTINGS_ROW_ID })
    .onConflictDoNothing();
}

/** Настройки приложения. Строки ещё нет — создаёт её со значениями по умолчанию. */
export async function readSettings(db: Database): Promise<AppSettings> {
  await ensureSettingsRow(db);
  const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, SETTINGS_ROW_ID));
  if (!settings) throw new Error("Строка настроек не создалась");
  return settings;
}

export async function updateSettings(db: Database, changes: AppSettingsChanges): Promise<AppSettings> {
  await ensureSettingsRow(db);
  if (Object.keys(changes).length > 0) {
    await db.update(appSettings).set(changes).where(eq(appSettings.id, SETTINGS_ROW_ID));
  }
  return readSettings(db);
}
