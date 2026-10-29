import { telegramApiFromEnv } from "../platform/env";
import type { ChannelAdapters } from "./channel";
import { FakeChannel } from "./fake";
import { createMaxAdapter } from "./max/adapter";
import { createTelegramAdapter } from "./telegram/adapter";
import { createVkAdapter } from "./vk/adapter";

/**
 * Адаптеры мессенджеров, подключённые в приложении.
 * `STUB_CHANNEL=fake` — для сквозных проверок: вместо Telegram подделка в памяти, в продакшене запрещена.
 */
export function createChannelAdapters(
  env: Record<string, string | undefined> = process.env,
  options: { fetch?: typeof fetch } = {},
): ChannelAdapters {
  if (env.STUB_CHANNEL === "fake") {
    if (env.NODE_ENV === "production")
      throw new Error("STUB_CHANNEL задана в продакшене: подделка мессенджера только для проверок. Уберите переменную.");
    return { telegram: new FakeChannel() };
  }
  return {
    telegram: createTelegramAdapter({ ...telegramApiFromEnv(env), fetch: options.fetch }),
    vk: createVkAdapter({ fetch: options.fetch }),
    max: createMaxAdapter({ fetch: options.fetch }),
  };
}
