// `connect-vk`: подключить сообщество ВК ключом со стандартного ввода — тем же путём, что форма «Боты» в кабинете.
// `--remove-callback <адрес>` затем убирает Callback-сервер другого приложения: только с точно таким адресом.
// Ключ не попадает ни в аргументы, ни в вывод, ни в тексты ошибок.
import { and, eq, isNull } from "drizzle-orm";
import { botWebhookUrl, toBotCredentials, type BotService } from "../channels/bots";
import { bots } from "../channels/schema";
import type { VkAdapter } from "../channels/vk/adapter";
import type { TokenCipher } from "../platform/crypto";
import type { Database } from "../platform/db";
import { CliInputError } from "./agent-settings";

export interface VkConnectionDependencies {
  botService: Pick<BotService, "connectBot">;
  vk: Pick<VkAdapter, "verifyToken" | "disconnect" | "callbackServerIds">;
  cipher: TokenCipher;
  /** Публичный адрес приложения: из него строятся адреса наших вебхуков. */
  publicBaseUrl: string;
}

export interface VkConnectionReport {
  botId: string;
  title: string;
  username: string;
  groupId: string;
  /** Сообщество уже было подключено: сервер не добавлялся заново. */
  alreadyConnected: boolean;
  callbackServerId: number;
  removedCallbackServerIds: number[];
}

/** Адрес сервера, который можно убрать: https и не наш вебхук. */
function removableUrl(raw: string | undefined, publicBaseUrl: string): string | undefined {
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliInputError(`--remove-callback: «${raw}» — не адрес`);
  }
  if (url.protocol !== "https:") throw new CliInputError("--remove-callback: нужен адрес https://");
  const ours = `${publicBaseUrl.replace(/\/+$/, "")}/api/webhooks/`;
  if (raw.startsWith(ours)) throw new CliInputError("--remove-callback: это адрес нашего бота, его убирает удаление бота в кабинете");
  return raw;
}

export async function connectVk(
  db: Database,
  deps: VkConnectionDependencies,
  stdin: string,
  removeCallback: string | undefined,
): Promise<VkConnectionReport> {
  const token = stdin.trim();
  if (!token) throw new CliInputError("Передайте ключ сообщества через стандартный ввод: … | lm.sh connect-vk");
  const toRemove = removableUrl(removeCallback, deps.publicBaseUrl);
  // Ключ мог оказаться в тексте ошибки ВК или нашей: в вывод он не уходит
  const hidden = (text: string) => text.replaceAll(token, "***");

  try {
    const identity = await deps.vk.verifyToken(token);
    const live = () =>
      db
        .select()
        .from(bots)
        .where(and(eq(bots.channel, "vk"), eq(bots.externalId, identity.externalId), eq(bots.status, "ok"), isNull(bots.deletedAt)));
    const [existing] = await live();
    if (!existing) {
      const connected = await deps.botService.connectBot({ channel: "vk", token });
      if (!connected.ok) throw new CliInputError(hidden(connected.error));
    }
    const [row] = existing ? [existing] : await live();
    if (!row) throw new CliInputError("Бот не сохранился после подключения");

    const credentials = toBotCredentials(row, deps.cipher);
    const [callbackServerId] = await deps.vk.callbackServerIds(credentials, botWebhookUrl(deps, "vk", row.id));
    if (callbackServerId === undefined) {
      throw new CliInputError("Нашего Callback-сервера в сообществе нет: удалите бота в кабинете и подключите заново");
    }

    // Чужой сервер убираем только после того, как наш принимает события: сообщество не остаётся без приёма
    const removedCallbackServerIds = toRemove ? await deps.vk.callbackServerIds(credentials, toRemove) : [];
    if (toRemove && removedCallbackServerIds.length > 0) await deps.vk.disconnect(credentials, toRemove);

    return {
      botId: row.id,
      title: row.title,
      username: row.username,
      groupId: row.externalId,
      alreadyConnected: Boolean(existing),
      callbackServerId,
      removedCallbackServerIds,
    };
  } catch (error) {
    if (error instanceof CliInputError) throw new CliInputError(hidden(error.message));
    throw new CliInputError(hidden(error instanceof Error ? error.message : String(error)));
  }
}
