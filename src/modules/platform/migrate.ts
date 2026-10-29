// Запуск: pnpm db:migrate
import { reportSettingsTranslation, translateSettingsToFlow } from "../flows";
import { connectDatabase, migrateDatabase } from "./db";
import { requireEnv } from "./env";

const connection = connectDatabase(requireEnv("DATABASE_URL"), { poolSize: 1 });
try {
  await migrateDatabase(connection);
  reportSettingsTranslation(await translateSettingsToFlow(connection.db));
  console.log("Миграции применены");
} finally {
  await connection.close();
}
