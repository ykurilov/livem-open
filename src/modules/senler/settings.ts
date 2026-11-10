import { and, eq, inArray, sql } from "drizzle-orm";
import { bots, leadMagnetBots } from "../channels/schema";
import type { TokenCipher } from "../platform/crypto";
import type { Database, DatabaseExecutor } from "../platform/db";
import { isUuid } from "../platform/uuid";
import { SenlerError, type SenlerAccess, type SenlerApi, type SenlerGroup } from "./api";
import { senlerAddedSubscribers, senlerConnections, senlerLeadMagnetGroups } from "./schema";

export type SenlerResult = { ok: true } | { ok: false; error: string };

/** Настройка Senler у бота — без ключа: ключ наружу не отдаётся. */
export interface SenlerBotSettings {
  defaultGroupId: string | null;
  /** Свои группы лидмагнитов этого бота; лидмагнита нет в списке — группа бота. */
  leadMagnetGroups: Record<string, string>;
  /** Последний отказ Senler: при добавлении человека или проверке подписчика. */
  lastError: string | null;
  /** Когда вставлен ключ: новый ключ — форма групп показывает его группы заново. */
  keyUpdatedAt: Date;
}

export interface SenlerSettings {
  /** Senler не подключён к боту — `null`. */
  load(botId: string): Promise<SenlerBotSettings | null>;
  /** Проверяет ключ запросом групп и сохраняет его зашифрованным. Новый ключ заменяет старый, группы остаются. */
  connect(botId: string, apiKey: string): Promise<SenlerResult>;
  /** Группа бота и свои группы лидмагнитов (`null` — «как у бота»). Каждая группа должна быть в Senler. */
  saveGroups(botId: string, input: { defaultGroupId: string | null; leadMagnetGroups: Record<string, string | null> }): Promise<SenlerResult>;
  listGroups(botId: string): Promise<{ ok: true; groups: SenlerGroup[] } | { ok: false; error: string }>;
  disconnect(botId: string): Promise<void>;
}

export interface SenlerDependencies {
  db: Database;
  cipher: TokenCipher;
  api: SenlerApi;
}

const NOT_CONNECTED = "Senler к этому боту не подключён";
const BOT_NOT_FOUND = "Бот не найден: возможно, его уже удалили";

const messageOf = (error: unknown) => (error instanceof SenlerError ? error.message : "Senler не отвечает, попробуйте чуть позже");

/** Ключ и сообщество бота для запросов к Senler. Senler не подключён или бот не ВК — `null`. */
export async function findSenlerAccess(db: DatabaseExecutor, cipher: TokenCipher, botId: string): Promise<SenlerAccess | null> {
  if (!isUuid(botId)) return null;
  const [row] = await db
    .select({ apiKeyEncrypted: senlerConnections.apiKeyEncrypted, channel: bots.channel, externalId: bots.externalId, deletedAt: bots.deletedAt })
    .from(senlerConnections)
    .innerJoin(bots, eq(bots.id, senlerConnections.botId))
    .where(eq(senlerConnections.botId, botId));
  if (!row || row.channel !== "vk" || row.deletedAt) return null;
  return { apiKey: cipher.decrypt(row.apiKeyEncrypted), vkGroupId: row.externalId };
}

export function createSenlerSettings(deps: SenlerDependencies): SenlerSettings {
  const { db, cipher, api } = deps;

  async function liveVkBot(botId: string) {
    if (!isUuid(botId)) return null;
    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    return bot && !bot.deletedAt ? bot : null;
  }

  return {
    async load(botId) {
      if (!isUuid(botId)) return null;
      const [connection] = await db.select().from(senlerConnections).where(eq(senlerConnections.botId, botId));
      if (!connection) return null;
      const groups = await db
        .select({ leadMagnetId: senlerLeadMagnetGroups.leadMagnetId, groupId: senlerLeadMagnetGroups.groupId })
        .from(senlerLeadMagnetGroups)
        .where(eq(senlerLeadMagnetGroups.botId, botId));
      return {
        defaultGroupId: connection.defaultGroupId,
        leadMagnetGroups: Object.fromEntries(groups.map((row) => [row.leadMagnetId, row.groupId])),
        lastError: connection.lastError,
        keyUpdatedAt: connection.updatedAt,
      };
    },

    async connect(botId, rawKey) {
      const apiKey = rawKey.trim();
      if (!apiKey) return { ok: false, error: "Вставьте ключ Senler" };
      const bot = await liveVkBot(botId);
      if (!bot) return { ok: false, error: BOT_NOT_FOUND };
      if (bot.channel !== "vk") return { ok: false, error: "Senler подключается только к боту ВКонтакте" };
      try {
        await api.listGroups({ apiKey, vkGroupId: bot.externalId });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const apiKeyEncrypted = cipher.encrypt(apiKey);
      await db
        .insert(senlerConnections)
        .values({ botId, apiKeyEncrypted })
        .onConflictDoUpdate({
          target: senlerConnections.botId,
          // Версия ключа для формы групп: часы базы, как у первой записи, и всегда позже прежней
          set: { apiKeyEncrypted, lastError: null, lastErrorAt: null, updatedAt: sql`greatest(${senlerConnections.updatedAt} + interval '1 millisecond', clock_timestamp())` },
        });
      return { ok: true };
    },

    async saveGroups(botId, input) {
      const access = await findSenlerAccess(db, cipher, botId);
      if (!access) return { ok: false, error: NOT_CONNECTED };
      const chosen = Object.entries(input.leadMagnetGroups).filter((entry): entry is [string, string] => Boolean(entry[1]));
      const leadMagnetIds = Object.keys(input.leadMagnetGroups);
      if (leadMagnetIds.some((id) => !isUuid(id))) return { ok: false, error: "Лидмагнит не найден" };
      if (leadMagnetIds.length > 0) {
        const attached = await db
          .select({ id: leadMagnetBots.leadMagnetId })
          .from(leadMagnetBots)
          .where(and(eq(leadMagnetBots.botId, botId), inArray(leadMagnetBots.leadMagnetId, leadMagnetIds)));
        if (attached.length !== leadMagnetIds.length) return { ok: false, error: "Своя группа — только у лидмагнита этого бота" };
      }

      const wanted = [input.defaultGroupId, ...chosen.map(([, groupId]) => groupId)].filter((id): id is string => Boolean(id));
      if (wanted.length > 0) {
        let existing: SenlerGroup[];
        try {
          existing = await api.listGroups(access);
        } catch (error) {
          return { ok: false, error: messageOf(error) };
        }
        const missing = wanted.find((id) => !existing.some((group) => group.id === id));
        if (missing) return { ok: false, error: "Группа подписчиков удалена в Senler: выберите другую" };
      }

      await db.transaction(async (tx) => {
        // Группы выбраны заново и все есть в Senler — прежняя ошибка («группа удалена» и т.п.) больше не о чём
        await tx.update(senlerConnections).set({ defaultGroupId: input.defaultGroupId, lastError: null, lastErrorAt: null }).where(eq(senlerConnections.botId, botId));
        if (leadMagnetIds.length > 0)
          await tx
            .delete(senlerLeadMagnetGroups)
            .where(and(eq(senlerLeadMagnetGroups.botId, botId), inArray(senlerLeadMagnetGroups.leadMagnetId, leadMagnetIds)));
        if (chosen.length > 0)
          await tx.insert(senlerLeadMagnetGroups).values(chosen.map(([leadMagnetId, groupId]) => ({ leadMagnetId, botId, groupId })));
      });
      return { ok: true };
    },

    async listGroups(botId) {
      const access = await findSenlerAccess(db, cipher, botId);
      if (!access) return { ok: false, error: NOT_CONNECTED };
      try {
        return { ok: true, groups: await api.listGroups(access) };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },

    async disconnect(botId) {
      if (!isUuid(botId)) return;
      await db.transaction((tx) => removeSenlerOfBot(tx, botId));
    },
  };
}

/** Всё о Senler у бота: ключ, группы, отметки «добавлен». Отключение Senler и удаление бота. */
export async function removeSenlerOfBot(tx: DatabaseExecutor, botId: string): Promise<void> {
  await tx.delete(senlerLeadMagnetGroups).where(eq(senlerLeadMagnetGroups.botId, botId));
  await tx.delete(senlerAddedSubscribers).where(eq(senlerAddedSubscribers.botId, botId));
  await tx.delete(senlerConnections).where(eq(senlerConnections.botId, botId));
}
