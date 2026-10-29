import { createHash } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { previewConversations } from "../consultant/schema";
import { passages } from "../conversations/schema";
import { leadMagnets } from "../lead-magnets/schema";
import type { DatabaseExecutor } from "../platform/db";
import { textShortLinks } from "./schema";
import { newShortCode, type ShortLinkLookup } from "./short-links";

const hashOf = (target: string) => createHash("sha256").update(target).digest("hex");

/** Сколько раз пробовать новый код, если случайный совпал с чужим. */
const CODE_ATTEMPTS = 5;

export interface ShortLinkStore extends ShortLinkLookup {
  /** Короткая ссылка на полную в этом разговоре: повтор того же адреса — тот же код. */
  shorten(input: { chatId: string; template: string; target: string }): Promise<string>;
  /** Лидмагнит разговора: прохождение или тестовый разговор «Проверки». */
  leadMagnetOf(chatId: string): Promise<string | null>;
}

export function createShortLinkStore(db: DatabaseExecutor, publicBaseUrl: string): ShortLinkStore {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const existing = async (chatId: string, targetHash: string) => {
    const [row] = await db
      .select({ code: textShortLinks.code })
      .from(textShortLinks)
      .where(and(eq(textShortLinks.chatId, chatId), eq(textShortLinks.targetHash, targetHash)));
    return row?.code ?? null;
  };
  const owner = async (chatId: string) => {
    const [passage] = await db.select({ id: passages.id, leadMagnetId: passages.leadMagnetId }).from(passages).where(eq(passages.chatId, chatId));
    if (passage) return { passageId: passage.id, leadMagnetId: passage.leadMagnetId };
    const [preview] = await db.select({ leadMagnetId: previewConversations.leadMagnetId }).from(previewConversations).where(eq(previewConversations.chatId, chatId));
    return { passageId: null, leadMagnetId: preview?.leadMagnetId ?? null };
  };

  return {
    async shorten({ chatId, template, target }) {
      const targetHash = hashOf(target);
      const found = await existing(chatId, targetHash);
      if (found) return `${base}/i/${found}`;
      const { passageId, leadMagnetId } = await owner(chatId);
      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
        const [inserted] = await db
          .insert(textShortLinks)
          .values({ code: newShortCode(), targetUrl: target, targetHash, template, chatId, leadMagnetId, passageId })
          .onConflictDoNothing()
          .returning({ code: textShortLinks.code });
        if (inserted) return `${base}/i/${inserted.code}`;
        // Не вставилось: тот же адрес записал параллельный вызов — его код; иначе совпал случайный код — новый
        const raced = await existing(chatId, targetHash);
        if (raced) return `${base}/i/${raced}`;
      }
      throw new Error("Не удалось завести короткую ссылку: коды совпадали");
    },
    async lookup(code) {
      const [row] = await db.select({ target: textShortLinks.targetUrl, template: textShortLinks.template }).from(textShortLinks).where(eq(textShortLinks.code, code));
      return row ?? null;
    },
    async services() {
      const rows = await db
        .selectDistinct({ template: sql<string>`${leadMagnets.draft} -> 'textLink' ->> 'template'` })
        .from(leadMagnets)
        .where(isNotNull(sql`${leadMagnets.draft} -> 'textLink' ->> 'template'`));
      const origins = rows.flatMap((row) => {
        try {
          return [`${new URL(row.template).origin}/`];
        } catch {
          return [];
        }
      });
      return [...new Set(origins)].slice(0, 3);
    },
    async leadMagnetOf(chatId) {
      return (await owner(chatId)).leadMagnetId;
    },
  };
}
