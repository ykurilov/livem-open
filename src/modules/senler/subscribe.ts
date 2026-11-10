import { and, eq } from "drizzle-orm";
import { passages } from "../conversations/schema";
import { entryLinks } from "../lead-magnets/schema";
import { people } from "../people/schema";
import type { DatabaseExecutor } from "../platform/db";
import { SenlerError } from "./api";
import { senlerAddedSubscribers, senlerConnections, senlerLeadMagnetGroups } from "./schema";
import { findSenlerAccess, type SenlerDependencies } from "./settings";

/** Для эксперта, когда упало не в Senler, а у нас: подробности — только в журнале сервера. */
const INTERNAL_FAILURE = "Не удалось добавить человека в Senler, попробуем ещё раз";

/**
 * Задача `senler-subscribe`: человек начал разговор по ссылке лидмагнита — в группу Senler (своя группа лидмагнита,
 * иначе группа бота), метка ссылки — источник. Кого бот уже добавлял в эту группу, не добавляет снова. Отказ Senler
 * (ключ, группа, сообщество) записывается у бота и не повторяется; «не отвечает» и наш сбой записываются и уходят
 * наверх — очередь повторит. Запрет сообщений от самого человека — не ошибка настройки: только журнал. Успех стирает ошибку.
 */
export async function subscribeToSenler(deps: SenlerDependencies, passageId: string): Promise<void> {
  const { db } = deps;
  const [row] = await db
    .select({ botId: people.botId, vkUserId: people.externalUserId, leadMagnetId: passages.leadMagnetId, label: entryLinks.label })
    .from(passages)
    .innerJoin(people, eq(people.id, passages.personId))
    .leftJoin(entryLinks, eq(entryLinks.id, passages.entryLinkId))
    .where(eq(passages.id, passageId));
  if (!row) return;
  const access = await findSenlerAccess(db, deps.cipher, row.botId);
  if (!access) return;
  const groupId = await senlerGroupFor(db, row.botId, row.leadMagnetId);
  if (!groupId) return;
  const added = { botId: row.botId, vkUserId: row.vkUserId, groupId };
  const [already] = await db
    .select({ groupId: senlerAddedSubscribers.groupId })
    .from(senlerAddedSubscribers)
    .where(and(eq(senlerAddedSubscribers.botId, row.botId), eq(senlerAddedSubscribers.vkUserId, row.vkUserId), eq(senlerAddedSubscribers.groupId, groupId)));
  if (already) return;

  try {
    await deps.api.addSubscriber(access, { vkUserId: row.vkUserId, groupId, source: row.label });
  } catch (error) {
    console.error(`Senler не добавил человека (прохождение ${passageId}):`, error instanceof Error ? error.message : error);
    if (error instanceof SenlerError && error.kind === "person_refused") return;
    const message = error instanceof SenlerError ? error.message : INTERNAL_FAILURE;
    await db.update(senlerConnections).set({ lastError: message, lastErrorAt: new Date() }).where(eq(senlerConnections.botId, row.botId));
    if (!(error instanceof SenlerError) || error.kind === "unavailable") throw error;
    return;
  }
  await db.insert(senlerAddedSubscribers).values(added).onConflictDoNothing();
  await db.update(senlerConnections).set({ lastError: null, lastErrorAt: null }).where(eq(senlerConnections.botId, row.botId));
}

/** Группа Senler, куда добавить пришедшего в этот лидмагнит на этом боте; не задана — `null`. */
export async function senlerGroupFor(db: DatabaseExecutor, botId: string, leadMagnetId: string): Promise<string | null> {
  const [own] = await db
    .select({ groupId: senlerLeadMagnetGroups.groupId })
    .from(senlerLeadMagnetGroups)
    .where(and(eq(senlerLeadMagnetGroups.botId, botId), eq(senlerLeadMagnetGroups.leadMagnetId, leadMagnetId)));
  if (own) return own.groupId;
  const [connection] = await db.select({ groupId: senlerConnections.defaultGroupId }).from(senlerConnections).where(eq(senlerConnections.botId, botId));
  return connection?.groupId ?? null;
}

/**
 * Подписчик ли человек Senler в сообществе бота. `off` — Senler не подключён или постоянно отказывает (ключ отозван,
 * другое сообщество, ответ непонятного вида): бот ведёт себя как без Senler, причина — в карточке Senler у бота.
 * Senler не ответил — `SenlerError` вида `unavailable` уходит наверх: решает вызывающий (повтор или как без Senler).
 */
export async function senlerSubscription(deps: SenlerDependencies, botId: string, vkUserId: string): Promise<"subscriber" | "not_subscriber" | "off"> {
  const access = await findSenlerAccess(deps.db, deps.cipher, botId);
  if (!access) return "off";
  try {
    return (await deps.api.isSubscriber(access, vkUserId)) ? "subscriber" : "not_subscriber";
  } catch (error) {
    if (error instanceof SenlerError && error.kind === "unavailable") throw error;
    const reason = error instanceof SenlerError ? error.message : "Не удалось проверить, подписан ли человек в Senler";
    console.error(`Senler: не проверили подписчика ${vkUserId}:`, error instanceof Error ? error.message : error);
    await recordSenlerError(deps.db, botId, `${reason}. Пока это не исправлено, бот отвечает всем, как без Senler`);
    return "off";
  }
}

/** Ошибка Senler — в карточку Senler у бота. */
export async function recordSenlerError(db: DatabaseExecutor, botId: string, message: string): Promise<void> {
  await db.update(senlerConnections).set({ lastError: message, lastErrorAt: new Date() }).where(eq(senlerConnections.botId, botId));
}
