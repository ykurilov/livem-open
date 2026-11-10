import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { ChannelAdapters, ChannelKind } from "../channels/channel";
import { bots, leadMagnetBots } from "../channels/schema";
import type { DatabaseExecutor } from "../platform/db";
import { isUuid } from "../platform/uuid";
import { LeadMagnetNotFoundError, lockLeadMagnet } from "./lead-magnets";
import { ensureMainEntryLink } from "./links";
import { entryLinks, leadMagnets, leadMagnetVersions } from "./schema";
import { validateLeadMagnetSettings } from "./settings";

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

const BOT_NOT_FOUND = "Бот не найден: возможно, его удалили";

export interface AttachedBot {
  botId: string;
  channel: ChannelKind;
  title: string;
  username: string;
  externalId: string;
}

export interface Publication {
  snapshotId: string | null;
  code: string | null;
  bots: Array<AttachedBot & { link: string | null }>;
  /** Ссылка на веб-чат: есть у любого опубликованного лидмагнита. */
  webLink: string | null;
}

/** Ссылка на веб-чат по коду ссылки лидмагнита. */
export function webChatLink(adapters: ChannelAdapters, code: string): string | null {
  return adapters.web?.entryLink({ username: "web", externalId: "web" }, code) ?? null;
}

/** Веб-ссылки опубликованных лидмагнитов одним запросом — для карточек списка; та же ссылка, что на странице «Публикация». */
export async function listWebLinksByLeadMagnet(db: DatabaseExecutor, adapters: ChannelAdapters): Promise<Map<string, string>> {
  const rows = await db
    .select({ leadMagnetId: entryLinks.leadMagnetId, code: entryLinks.code })
    .from(entryLinks)
    .innerJoin(leadMagnets, eq(leadMagnets.id, entryLinks.leadMagnetId))
    .where(and(isNull(entryLinks.label), isNotNull(leadMagnets.publishedSnapshotId)));
  const links = new Map<string, string>();
  for (const { leadMagnetId, code } of rows) {
    const link = webChatLink(adapters, code);
    if (link) links.set(leadMagnetId, link);
  }
  return links;
}

/** Привязывает бота к лидмагниту. На мессенджер — один бот: новый заменяет прежнего. */
export async function attachBot(db: DatabaseExecutor, input: { leadMagnetId: string; botId: string }): Promise<void> {
  // Строка бота держится до конца транзакции: удаление бота не проскочит между проверкой и привязкой
  const [bot] = await db
    .select({ channel: bots.channel })
    .from(bots)
    .where(and(eq(bots.id, input.botId), isNull(bots.deletedAt)))
    .for("share");
  if (!bot) throw new PublishError(BOT_NOT_FOUND);
  const [previous] = await db
    .select({ botId: leadMagnetBots.botId })
    .from(leadMagnetBots)
    .where(and(eq(leadMagnetBots.leadMagnetId, input.leadMagnetId), eq(leadMagnetBots.channel, bot.channel)));
  await db
    .insert(leadMagnetBots)
    .values({ leadMagnetId: input.leadMagnetId, botId: input.botId, channel: bot.channel })
    .onConflictDoUpdate({ target: [leadMagnetBots.leadMagnetId, leadMagnetBots.channel], set: { botId: input.botId } });
  if (previous && previous.botId !== input.botId) await dropDefaultLeadMagnet(db, previous.botId, input.leadMagnetId);
}

export async function detachBot(db: DatabaseExecutor, input: { leadMagnetId: string; channel: ChannelKind }): Promise<void> {
  const detached = await db
    .delete(leadMagnetBots)
    .where(and(eq(leadMagnetBots.leadMagnetId, input.leadMagnetId), eq(leadMagnetBots.channel, input.channel)))
    .returning({ botId: leadMagnetBots.botId });
  for (const { botId } of detached) await dropDefaultLeadMagnet(db, botId, input.leadMagnetId);
}

/**
 * Лидмагнит ушёл с бота, а был у него «по умолчанию»: режим бота — «ничего» (без лидмагнита «по умолчанию» настройки
 * бота не сохраняются). Иначе новички прежнего бота так и попадали бы в лидмагнит, который эксперт там уже не видит.
 */
async function dropDefaultLeadMagnet(db: DatabaseExecutor, botId: string, leadMagnetId: string): Promise<void> {
  await db
    .update(bots)
    .set({ noCodeMode: "nothing", defaultLeadMagnetId: null })
    .where(and(eq(bots.id, botId), eq(bots.defaultLeadMagnetId, leadMagnetId)));
}

export async function listAttachedBots(db: DatabaseExecutor, leadMagnetId: string): Promise<AttachedBot[]> {
  return db
    .select({ botId: bots.id, channel: bots.channel, title: bots.title, username: bots.username, externalId: bots.externalId })
    .from(leadMagnetBots)
    .innerJoin(bots, eq(bots.id, leadMagnetBots.botId))
    .where(eq(leadMagnetBots.leadMagnetId, leadMagnetId))
    .orderBy(asc(leadMagnetBots.channel));
}

/** Привязанные боты всех лидмагнитов одним запросом — для карточек списка. */
export async function listAttachedBotsByLeadMagnet(db: DatabaseExecutor): Promise<Map<string, AttachedBot[]>> {
  const rows = await db
    .select({ leadMagnetId: leadMagnetBots.leadMagnetId, botId: bots.id, channel: bots.channel, title: bots.title, username: bots.username, externalId: bots.externalId })
    .from(leadMagnetBots)
    .innerJoin(bots, eq(bots.id, leadMagnetBots.botId))
    .orderBy(asc(leadMagnetBots.channel));
  const byLeadMagnet = new Map<string, AttachedBot[]>();
  for (const { leadMagnetId, ...bot } of rows) byLeadMagnet.set(leadMagnetId, [...(byLeadMagnet.get(leadMagnetId) ?? []), bot]);
  return byLeadMagnet;
}

/**
 * Публикация: текущая версия черновика становится снимком, у лидмагнита появляется основная ссылка (одна на все
 * мессенджеры). Начатые прохождения остаются на своих снимках, новые идут по новому.
 */
export async function publishLeadMagnet(
  db: DatabaseExecutor,
  leadMagnetId: string,
): Promise<{ snapshotId: string; code: string }> {
  return db.transaction(async (tx) => {
    const lead = await lockLeadMagnet(tx, leadMagnetId);
    // Строки ботов держатся до конца: удаление бота дождётся публикации и увидит её (или публикация — удаление)
    const live = await tx
      .select({ botId: bots.id })
      .from(leadMagnetBots)
      .innerJoin(bots, eq(bots.id, leadMagnetBots.botId))
      .where(and(eq(leadMagnetBots.leadMagnetId, leadMagnetId), isNull(bots.deletedAt)))
      .for("update");
    if (live.length === 0) throw new PublishError("Привяжите хотя бы одного бота");
    validateLeadMagnetSettings(lead.draft);

    // Версии неизменны: снимок — это версия черновика с пометкой, копия не нужна
    await tx.update(leadMagnetVersions).set({ isSnapshot: true }).where(eq(leadMagnetVersions.id, lead.draftVersionId));
    await tx.update(leadMagnets).set({ publishedSnapshotId: lead.draftVersionId }).where(eq(leadMagnets.id, leadMagnetId));
    const link = await ensureMainEntryLink(tx, leadMagnetId);
    return { snapshotId: lead.draftVersionId, code: link.code };
  });
}

/**
 * Снятие с публикации: ссылки перестают запускать лидмагнит (у бота срабатывает поведение «без кода»), а начатые
 * прохождения доигрывают на своих снимках. Боты остаются привязанными — опубликовать снова можно в один шаг.
 */
export async function unpublishLeadMagnet(db: DatabaseExecutor, leadMagnetId: string): Promise<void> {
  if (!isUuid(leadMagnetId)) throw new LeadMagnetNotFoundError(leadMagnetId);
  await db.transaction(async (tx) => {
    await lockLeadMagnet(tx, leadMagnetId);
    await tx.update(leadMagnets).set({ publishedSnapshotId: null }).where(eq(leadMagnets.id, leadMagnetId));
  });
}

const DRAFT_CHANGED = "Черновик изменился, пока была открыта эта страница: обновите её и проверьте, что публикуете";

/**
 * Выбор ботов по мессенджерам (`null` — отвязать) и публикация — одним целым: не опубликовалось — привязки прежние.
 * Чужие id (не UUID, удалённые) — понятная ошибка, а не сбой базы. `expectedDraftVersionId` — версия черновика, которую
 * видел эксперт: черновик с тех пор изменился — не публикуется ничего.
 */
export async function publishWithBots(
  db: DatabaseExecutor,
  leadMagnetId: string,
  choices: Partial<Record<ChannelKind, string | null>>,
  options: { expectedDraftVersionId?: string } = {},
): Promise<{ snapshotId: string; code: string }> {
  if (!isUuid(leadMagnetId)) throw new LeadMagnetNotFoundError(leadMagnetId);
  return db.transaction(async (tx) => {
    const lead = await lockLeadMagnet(tx, leadMagnetId);
    if (options.expectedDraftVersionId !== undefined && lead.draftVersionId !== options.expectedDraftVersionId)
      throw new PublishError(DRAFT_CHANGED);
    for (const [channel, botId] of Object.entries(choices) as Array<[ChannelKind, string | null | undefined]>) {
      if (botId === undefined) continue;
      if (botId === null) await detachBot(tx, { leadMagnetId, channel });
      else {
        if (!isUuid(botId)) throw new PublishError(BOT_NOT_FOUND);
        await attachBot(tx, { leadMagnetId, botId });
      }
    }
    return publishLeadMagnet(tx, leadMagnetId);
  });
}

/** Лидмагниты, привязанные к боту: из них выбирается лидмагнит по умолчанию. */
export async function listBotLeadMagnets(
  db: DatabaseExecutor,
  botId: string,
): Promise<Array<{ id: string; name: string; published: boolean }>> {
  if (!isUuid(botId)) return [];
  const rows = await db
    .select({ id: leadMagnets.id, draft: leadMagnets.draft, snapshotId: leadMagnets.publishedSnapshotId })
    .from(leadMagnetBots)
    .innerJoin(leadMagnets, eq(leadMagnets.id, leadMagnetBots.leadMagnetId))
    .where(eq(leadMagnetBots.botId, botId))
    .orderBy(asc(leadMagnets.createdAt), asc(leadMagnets.id));
  return rows.map((row) => ({ id: row.id, name: row.draft.name, published: row.snapshotId !== null }));
}

/** Что опубликовано и по каким ссылкам. Ссылка на бота строится его мессенджером. */
export async function describePublication(
  db: DatabaseExecutor,
  adapters: ChannelAdapters,
  leadMagnetId: string,
): Promise<Publication> {
  const [lead] = await db
    .select({ snapshotId: leadMagnets.publishedSnapshotId })
    .from(leadMagnets)
    .where(eq(leadMagnets.id, leadMagnetId));
  const [mainLink] = await db
    .select({ code: entryLinks.code })
    .from(entryLinks)
    .where(and(eq(entryLinks.leadMagnetId, leadMagnetId), isNull(entryLinks.label)));
  const code = lead?.snapshotId && mainLink ? mainLink.code : null;
  const attached = await listAttachedBots(db, leadMagnetId);
  return {
    snapshotId: lead?.snapshotId ?? null,
    code,
    webLink: code ? webChatLink(adapters, code) : null,
    bots: attached.map((bot) => ({
      ...bot,
      link: code ? (adapters[bot.channel]?.entryLink(bot, code) ?? null) : null,
    })),
  };
}
