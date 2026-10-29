import { and, eq, isNull } from "drizzle-orm";
import { passages } from "../conversations/schema";
import { getVersion, type LeadMagnetSettings } from "../lead-magnets";
import { people } from "../people/schema";
import type { DatabaseExecutor } from "../platform/db";
import { containsProductLink, tagProductLinks, type ProductLink } from "./product-links";
import { newTrackingCode } from "./tracking-code";

/** Ссылки продуктов снимка; у снимков до появления поля их нет. */
export const productLinksOf = (settings: Pick<LeadMagnetSettings, "productLinks">): ProductLink[] => settings.productLinks ?? [];

/** Личный код прохождения: есть — он, нет — новый. Две отправки разом получат один код: пишет первая, вторая читает. */
export async function ensureTrackingCode(db: DatabaseExecutor, passageId: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [current] = await db.select({ code: passages.trackingCode }).from(passages).where(eq(passages.id, passageId));
    if (!current) throw new Error(`Прохождение ${passageId} не найдено`);
    if (current.code) return current.code;
    try {
      await db.update(passages).set({ trackingCode: newTrackingCode() }).where(and(eq(passages.id, passageId), isNull(passages.trackingCode)));
    } catch (error) {
      // Совпал с чужим кодом (уникальный индекс) — следующая попытка с новым
      if ((error as { code?: string }).code !== "23505") throw error;
    }
  }
  throw new Error(`Не удалось завести личный код прохождения ${passageId}`);
}

/**
 * Тексты сообщения прохождения человеку — со ссылками продуктов в метках (канал и личный код). История модели этих
 * меток не видит: размечается только то, что уходит в мессенджер. Без ссылок продукта тексты как есть, код не заводится.
 */
export async function tagPassageTexts(db: DatabaseExecutor, passageId: string, texts: readonly string[]): Promise<string[]> {
  const [passage] = await db
    .select({ snapshotId: passages.snapshotId, channel: people.channel })
    .from(passages)
    .innerJoin(people, eq(people.id, passages.personId))
    .where(eq(passages.id, passageId));
  if (!passage) return [...texts];
  const snapshot = await getVersion(db, passage.snapshotId);
  const products = snapshot ? productLinksOf(snapshot.settings) : [];
  if (!texts.some((text) => containsProductLink(text, products))) return [...texts];
  const tag = { medium: passage.channel, content: await ensureTrackingCode(db, passageId) };
  return texts.map((text) => tagProductLinks(text, products, tag));
}

/** Одна строка — то же, что `tagPassageTexts`. */
export async function tagPassageText(db: DatabaseExecutor, passageId: string, text: string): Promise<string> {
  return (await tagPassageTexts(db, passageId, [text]))[0]!;
}
