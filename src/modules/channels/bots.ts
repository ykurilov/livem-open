import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import type { AlertService } from "../alerts";
import { endActivePassages } from "../conversations/passage-end";
import { passages } from "../conversations/schema";
import { leadMagnets, leadMagnetVersions } from "../lead-magnets/schema";
import { people } from "../people/schema";
import type { TokenCipher } from "../platform/crypto";
import { isUniqueViolation, type Database, type DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { isUuid } from "../platform/uuid";
import type { BotCredentials, ChannelAdapters, ChannelKind } from "./channel";
import { requeueAfterBotRepair } from "./outbound";
import { bots, leadMagnetBots, NO_CODE_MODES, type BotStatus, type NoCodeMode } from "./schema";

export interface BotSummary {
  id: string;
  channel: ChannelKind;
  title: string;
  username: string;
  status: BotStatus;
  statusError: string | null;
  /** Что бот делает, если человек пришёл без кода лидмагнита. */
  noCodeMode: NoCodeMode;
  defaultLeadMagnetId: string | null;
  createdAt: Date;
}

/** `needsConfirmation` — бот занят другим сервисом: `error` — вопрос эксперту, подключение повторяется с `force`. */
export type ConnectBotResult = { ok: true; bot: BotSummary } | { ok: false; error: string; needsConfirmation?: true };

export interface BotService {
  /**
   * Проверяет токен, настраивает приём сообщений и сохраняет бота. Бот с ошибкой подключается заново с новым токеном.
   * Бот, которого уже читает другой сервис, не подключается без `force`: сначала вопрос эксперту.
   */
  connectBot(input: { channel: ChannelKind; token: string; force?: boolean }): Promise<ConnectBotResult>;
  listBots(): Promise<BotSummary[]>;
  /** Бот по id; удалённый или чужой id — `null`. */
  getBot(botId: string): Promise<BotSummary | null>;
  loadBotCredentials(botId: string): Promise<BotCredentials | null>;
  /** Поведение без кода. Лидмагнит по умолчанию — один из привязанных к этому боту. */
  updateNoCodeSettings(botId: string, settings: NoCodeSettings): Promise<BotActionResult>;
  /** Сколько разговоров сейчас идёт на боте: при удалении они закроются. */
  countActiveConversations(botId: string): Promise<number>;
  /**
   * Удаляет бота. Пока на нём есть опубликованные лидмагниты — отказ с объяснением.
   * Идущие разговоры закрываются как «не завершил»: отвечать и напоминать больше некому.
   */
  deleteBot(botId: string): Promise<BotActionResult>;
}

export interface NoCodeSettings {
  mode: NoCodeMode;
  defaultLeadMagnetId: string | null;
}

export type BotActionResult = { ok: true } | { ok: false; error: string };

const BOT_NOT_FOUND = "Бот не найден: возможно, его уже удалили";

export interface BotServiceDependencies {
  db: Database;
  adapters: ChannelAdapters;
  cipher: TokenCipher;
  /** Тревога «бот не работает» снимается, когда бот подключён заново. */
  alerts: Pick<AlertService, "resolve">;
  /** Бот подключён заново: сообщения, не ушедшие из-за него, ставятся в очередь снова. */
  queue: JobEnqueuer;
  /** Публичный адрес приложения: на него мессенджер шлёт вебхуки. */
  publicBaseUrl: string;
  /** Адрес для вебхуков Telegram, если они идут к нам через пересылку на прокси (Telegram не достучится до сервера в РФ). */
  telegramWebhookBaseUrl?: string;
}

export type BotRow = typeof bots.$inferSelect;

export function toBotCredentials(row: BotRow, cipher: TokenCipher): BotCredentials {
  return {
    id: row.id,
    token: cipher.decrypt(row.tokenEncrypted),
    externalId: row.externalId,
    username: row.username,
    webhookSecret: row.webhookSecret,
  };
}


/** Бот и его расшифрованные данные для адаптера. Чужой или кривой id — `null`, без обращения к базе с мусором. */
export async function findBotWithCredentials(
  db: DatabaseExecutor,
  cipher: TokenCipher,
  botId: string,
): Promise<{ bot: BotRow; credentials: BotCredentials } | null> {
  if (!isUuid(botId)) return null;
  const [row] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), isNull(bots.deletedAt)));
  return row ? { bot: row, credentials: toBotCredentials(row, cipher) } : null;
}

function toSummary(row: BotRow): BotSummary {
  return {
    id: row.id,
    channel: row.channel,
    title: row.title,
    username: row.username,
    status: row.status,
    statusError: row.statusError,
    noCodeMode: row.noCodeMode,
    defaultLeadMagnetId: row.defaultLeadMagnetId,
    createdAt: row.createdAt,
  };
}

/** Неудалённые боты по порядку подключения. */
export async function listLiveBots(db: DatabaseExecutor): Promise<BotSummary[]> {
  const rows = await db.select().from(bots).where(isNull(bots.deletedAt)).orderBy(asc(bots.createdAt), asc(bots.id));
  return rows.map(toSummary);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Адрес, на который мессенджер шлёт вебхуки этого бота. */
export function botWebhookUrl(
  addresses: Pick<BotServiceDependencies, "publicBaseUrl" | "telegramWebhookBaseUrl">,
  channel: ChannelKind,
  botId: string,
): string {
  const base = (channel === "telegram" && addresses.telegramWebhookBaseUrl) || addresses.publicBaseUrl;
  return `${base.replace(/\/+$/, "")}/api/webhooks/${channel}/${botId}`;
}

export function createBotService(deps: BotServiceDependencies): BotService {
  const { db, adapters, cipher } = deps;
  const webhookUrl = (channel: ChannelKind, botId: string) => botWebhookUrl(deps, channel, botId);

  return {
    async connectBot({ channel, token: rawToken, force }) {
      const adapter = adapters[channel];
      if (!adapter) return { ok: false, error: "Подключение этого мессенджера ещё не готово" };
      const token = rawToken.trim();
      if (!token) return { ok: false, error: "Вставьте токен бота" };
      const formatError = adapter.validateTokenFormat?.(token);
      if (formatError) return { ok: false, error: formatError };
      if (!deps.publicBaseUrl) return { ok: false, error: "Не задан публичный адрес приложения (PUBLIC_BASE_URL)" };

      let identity;
      try {
        identity = await adapter.verifyToken(token);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }

      const [existing] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.channel, channel), eq(bots.externalId, identity.externalId)));

      if (existing && existing.status === "ok" && !existing.deletedAt) return { ok: false, error: "Этот бот уже подключён" };

      // Подключение перебьёт чужой приём сообщений: сначала спрашиваем эксперта
      if (!force && adapter.findConflict) {
        try {
          const conflict = await adapter.findConflict(token, existing ? webhookUrl(channel, existing.id) : null);
          if (conflict) return { ok: false, error: conflict, needsConfirmation: true };
        } catch (error) {
          return { ok: false, error: `Не удалось проверить, свободен ли бот: ${messageOf(error)}` };
        }
      }

      if (existing) {
        return reconnect(existing, token, identity);
      }

      const id = randomUUID();
      const webhookSecret = randomBytes(32).toString("base64url");
      let created: BotRow | undefined;
      try {
        [created] = await db
          .insert(bots)
          .values({
            id,
            channel,
            title: identity.title,
            externalId: identity.externalId,
            username: identity.username,
            tokenEncrypted: cipher.encrypt(token),
            webhookSecret,
          })
          .returning();
      } catch (error) {
        // Два одновременных подключения одного бота: второе упирается в уникальность
        if (isUniqueViolation(error)) return { ok: false, error: "Этот бот уже подключён" };
        throw error;
      }
      if (!created) throw new Error("Бот не сохранился");

      // Сначала запись, потом настройка приёма: первое же сообщение найдёт бота в базе
      try {
        await adapter.connect(
          { id, token, externalId: identity.externalId, username: identity.username, webhookSecret },
          webhookUrl(channel, id),
        );
      } catch (error) {
        await db.delete(bots).where(eq(bots.id, id));
        return { ok: false, error: `Не удалось настроить приём сообщений: ${messageOf(error)}` };
      }
      return { ok: true, bot: toSummary(created) };
    },

    listBots: () => listLiveBots(db),

    async getBot(botId) {
      if (!isUuid(botId)) return null;
      const [row] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.id, botId), isNull(bots.deletedAt)));
      return row ? toSummary(row) : null;
    },

    async loadBotCredentials(botId) {
      const [row] = await db.select().from(bots).where(eq(bots.id, botId));
      return row ? toBotCredentials(row, cipher) : null;
    },

    async updateNoCodeSettings(botId, settings) {
      if (!NO_CODE_MODES.includes(settings.mode)) return { ok: false, error: "Выберите, что делать без кода" };
      const defaultLeadMagnetId = settings.mode === "default" ? settings.defaultLeadMagnetId : null;
      if (settings.mode === "default" && !defaultLeadMagnetId) return { ok: false, error: "Выберите лидмагнит по умолчанию" };
      if (!isUuid(botId)) return { ok: false, error: BOT_NOT_FOUND };
      if (defaultLeadMagnetId) {
        const [attached] = isUuid(defaultLeadMagnetId)
          ? await db
              .select({ id: leadMagnetBots.leadMagnetId })
              .from(leadMagnetBots)
              .where(and(eq(leadMagnetBots.botId, botId), eq(leadMagnetBots.leadMagnetId, defaultLeadMagnetId)))
          : [];
        if (!attached) return { ok: false, error: "Лидмагнит по умолчанию должен быть привязан к этому боту" };
      }
      const [updated] = await db
        .update(bots)
        .set({ noCodeMode: settings.mode, defaultLeadMagnetId })
        .where(and(eq(bots.id, botId), isNull(bots.deletedAt)))
        .returning({ id: bots.id });
      return updated ? { ok: true } : { ok: false, error: BOT_NOT_FOUND };
    },

    async countActiveConversations(botId) {
      if (!isUuid(botId)) return 0;
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(passages)
        .innerJoin(people, eq(people.id, passages.personId))
        .where(and(eq(people.botId, botId), eq(passages.status, "active")));
      return row?.count ?? 0;
    },

    async deleteBot(botId) {
      if (!isUuid(botId)) return { ok: false, error: BOT_NOT_FOUND };
      const deleted = await db.transaction(async (tx): Promise<BotActionResult & { row?: BotRow }> => {
        // Строка бота держится до конца: публикация с этим ботом не проскочит между проверкой и удалением
        const [row] = await tx
          .select()
          .from(bots)
          .where(and(eq(bots.id, botId), isNull(bots.deletedAt)))
          .for("update");
        if (!row) return { ok: false, error: BOT_NOT_FOUND };
        const published = await tx
          .select({ settings: leadMagnetVersions.settings })
          .from(leadMagnetBots)
          .innerJoin(leadMagnets, eq(leadMagnets.id, leadMagnetBots.leadMagnetId))
          .innerJoin(leadMagnetVersions, eq(leadMagnetVersions.id, leadMagnets.publishedSnapshotId))
          .where(and(eq(leadMagnetBots.botId, botId), isNotNull(leadMagnets.publishedSnapshotId)));
        if (published.length > 0) {
          const names = published.map((lead) => `«${lead.settings.name}»`).join(", ");
          return { ok: false, error: `Бота нельзя удалить: сначала снимите с публикации его лидмагниты: ${names}` };
        }
        // Разговоры бота закрываются: без бота ответы и напоминания не дойдут, а тратить на них модель незачем
        const ofBot = inArray(passages.personId, tx.select({ id: people.id }).from(people).where(eq(people.botId, botId)));
        await endActivePassages(tx, ofBot, "not_completed", new Date());
        // Привязки к неопубликованным лидмагнитам снимаются: удалённый бот не должен вернуться при публикации
        await tx.delete(leadMagnetBots).where(eq(leadMagnetBots.botId, botId));
        await tx.update(bots).set({ deletedAt: new Date(), defaultLeadMagnetId: null }).where(eq(bots.id, botId));
        return { ok: true, row };
      });
      if (!deleted.ok || !deleted.row) return deleted.ok ? { ok: true } : deleted;
      // Тревога «бот не работает» об удалённом боте больше не нужна
      await deps.alerts.resolve("bot_error", botId);

      // Приём сообщений убираем после записи: удалённый бот уже отклоняет вебхуки, даже если мессенджер недоступен
      const adapter = adapters[deleted.row.channel];
      try {
        await adapter?.disconnect(toBotCredentials(deleted.row, cipher), webhookUrl(deleted.row.channel, deleted.row.id));
      } catch (error) {
        console.error(`Бот ${botId} удалён, но приём сообщений не отключён:`, messageOf(error));
      }
      return { ok: true };
    },
  };

  async function reconnect(
    existing: BotRow,
    token: string,
    identity: { title: string; username: string },
  ): Promise<ConnectBotResult> {
    const adapter = adapters[existing.channel];
    if (!adapter) return { ok: false, error: "Подключение этого мессенджера ещё не готово" };
    try {
      await adapter.connect(
        { ...toBotCredentials(existing, cipher), token, username: identity.username },
        webhookUrl(existing.channel, existing.id),
      );
    } catch (error) {
      return { ok: false, error: `Не удалось настроить приём сообщений: ${messageOf(error)}` };
    }
    const [updated] = await db
      .update(bots)
      .set({
        tokenEncrypted: cipher.encrypt(token),
        title: identity.title,
        username: identity.username,
        status: "ok",
        statusError: null,
        deletedAt: null,
      })
      .where(eq(bots.id, existing.id))
      .returning();
    if (!updated) throw new Error("Бот пропал во время повторного подключения");
    await deps.alerts.resolve("bot_error", existing.id);
    try {
      await requeueAfterBotRepair(deps, existing.id);
    } catch (error) {
      // Бот уже подключён; не вставшие сообщения поставит следующая проверка ботов
      console.error(`Бот ${existing.id} подключён, но ждущие сообщения не поставлены:`, messageOf(error));
    }
    return { ok: true, bot: toSummary(updated) };
  }
}
