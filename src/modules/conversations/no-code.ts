import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { OutgoingMessage } from "../channels/channel";
import { leadMagnetBots, type bots } from "../channels/schema";
import { entryLinks, leadMagnets, leadMagnetVersions } from "../lead-magnets/schema";
import type { DatabaseExecutor } from "../platform/db";

/** Текст над кнопками меню. */
export const MENU_TEXT = "Выберите, с чего начнём:";

/** Самый строгий предел надписи на кнопке среди мессенджеров (ВК — 40 знаков). */
export const MENU_BUTTON_LABEL_LIMIT = 40;

const MENU_PAYLOAD_PREFIX = "start:";

/** Что зашито в кнопку меню: код основной ссылки лидмагнита. Нажатие — как переход по этой ссылке. */
export function menuButtonPayload(code: string): string {
  return `${MENU_PAYLOAD_PREFIX}${code}`;
}

/** Код ссылки из нажатой кнопки; кнопка не из меню — `null`. */
export function codeFromMenuPayload(payload: string | null): string | null {
  if (!payload?.startsWith(MENU_PAYLOAD_PREFIX)) return null;
  return payload.slice(MENU_PAYLOAD_PREFIX.length) || null;
}

/** С чего начать прохождение: опубликованный снимок лидмагнита и ссылка, по которой пришёл человек. */
export interface StartTarget {
  leadMagnetId: string;
  snapshotId: string;
  entryLinkId?: string;
}

/** Опубликованный лидмагнит; снятый с публикации или удалённый — `null`. */
export async function findPublishedTarget(tx: DatabaseExecutor, leadMagnetId: string): Promise<StartTarget | null> {
  const [lead] = await tx
    .select({ id: leadMagnets.id, snapshotId: leadMagnets.publishedSnapshotId })
    .from(leadMagnets)
    .where(and(eq(leadMagnets.id, leadMagnetId), isNotNull(leadMagnets.publishedSnapshotId)));
  return lead ? { leadMagnetId: lead.id, snapshotId: lead.snapshotId! } : null;
}

/** Ответ бота человеку, пришедшему без кода: молча во «Входящие», лидмагнит по умолчанию или меню. */
export type NoCodeReply = { kind: "inbox" } | { kind: "start"; target: StartTarget } | { kind: "menu" };

/**
 * Что делать без кода по настройке бота. Лидмагнит по умолчанию снят или в меню нечего показать — как «ничего»:
 * человек не останется без внимания эксперта.
 */
export async function chooseNoCodeReply(tx: DatabaseExecutor, bot: typeof bots.$inferSelect): Promise<NoCodeReply> {
  if (bot.noCodeMode === "default" && bot.defaultLeadMagnetId) {
    const target = await findPublishedTarget(tx, bot.defaultLeadMagnetId);
    if (target) return { kind: "start", target };
  }
  if (bot.noCodeMode === "menu" && (await publishedLeadMagnetsOfBot(tx, bot.id)).length > 0) return { kind: "menu" };
  return { kind: "inbox" };
}

/** Меню бота: по кнопке на каждый опубликованный лидмагнит. Показать нечего — `null`. */
export async function buildMenu(db: DatabaseExecutor, botId: string): Promise<Pick<OutgoingMessage, "text" | "buttons"> | null> {
  const published = await publishedLeadMagnetsOfBot(db, botId);
  if (published.length === 0) return null;
  return {
    text: MENU_TEXT,
    buttons: published.map((lead) => ({ label: buttonLabel(lead.name), payload: menuButtonPayload(lead.code) })),
  };
}

/** Лидмагнит опубликован на этом боте: только такой запускает кнопка меню. */
export async function isPublishedOnBot(tx: DatabaseExecutor, botId: string, leadMagnetId: string): Promise<boolean> {
  return (await publishedLeadMagnetsOfBot(tx, botId)).some((lead) => lead.leadMagnetId === leadMagnetId);
}

/** Опубликованные лидмагниты бота с названием из опубликованного снимка и кодом основной ссылки. */
async function publishedLeadMagnetsOfBot(
  db: DatabaseExecutor,
  botId: string,
): Promise<Array<{ leadMagnetId: string; name: string; code: string }>> {
  const rows = await db
    .select({ leadMagnetId: leadMagnets.id, settings: leadMagnetVersions.settings, code: entryLinks.code })
    .from(leadMagnetBots)
    .innerJoin(leadMagnets, eq(leadMagnets.id, leadMagnetBots.leadMagnetId))
    .innerJoin(leadMagnetVersions, eq(leadMagnetVersions.id, leadMagnets.publishedSnapshotId))
    .innerJoin(entryLinks, and(eq(entryLinks.leadMagnetId, leadMagnets.id), isNull(entryLinks.label)))
    .where(eq(leadMagnetBots.botId, botId))
    .orderBy(asc(leadMagnets.createdAt), asc(leadMagnets.id));
  return rows.map((row) => ({ leadMagnetId: row.leadMagnetId, name: row.settings.name, code: row.code }));
}

function buttonLabel(name: string): string {
  const label = name.trim();
  return label.length <= MENU_BUTTON_LABEL_LIMIT ? label : `${label.slice(0, MENU_BUTTON_LABEL_LIMIT - 1).trimEnd()}…`;
}
