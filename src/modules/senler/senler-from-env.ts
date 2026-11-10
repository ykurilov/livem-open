import { createTokenCipher } from "../platform/crypto";
import { getDatabase } from "../platform/db";
import { requireEnv } from "../platform/env";
import { createSenlerApi, type SenlerApi } from "./api";
import { FakeSenlerApi } from "./fake-senler-api";
import { createSenlerSettings, type SenlerSettings } from "./settings";

/**
 * Senler для приложения. `STUB_SENLER=fake` — для сквозных проверок: подделка в памяти (ключ `senler-key-ok`,
 * группы «Подписчики марафона» и «Весенний интенсив»), в продакшене запрещена. `SENLER_API_URL` — другой адрес API.
 */
export function senlerApiFromEnv(env: Record<string, string | undefined> = process.env): SenlerApi {
  if (env.STUB_SENLER === "fake") {
    if (env.NODE_ENV === "production") throw new Error("STUB_SENLER задана в продакшене: подделка Senler только для проверок. Уберите переменную.");
    const fake = new FakeSenlerApi();
    fake.acceptAnyCommunity = true;
    return createSenlerApi({ fetch: fake.fetch });
  }
  return createSenlerApi({ baseUrl: env.SENLER_API_URL });
}

/** Настройка Senler для кабинета: база, шифр ботов и API — из окружения. */
export function createSenlerSettingsFromEnv(): SenlerSettings {
  return createSenlerSettings({ db: getDatabase().db, cipher: createTokenCipher(requireEnv("BOT_TOKEN_KEY")), api: senlerApiFromEnv() });
}
