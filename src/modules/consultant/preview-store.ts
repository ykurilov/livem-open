import { eq, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../platform/db";
import { nextSaleAnswer } from "../program/sale-answer";
import { previewConversations, type DialogSummary, type SaleAnswer, type SaleReason } from "./schema";
import { previewPurchasePort } from "../purchases/ports";
import type { PurchasePort } from "../purchases/tools";
import { optionalEnv } from "../platform/env";
import { createShortLinkStore, type ShortLinkStore } from "../text-links/server";

/** Короткие ссылки по публичному адресу приложения; адреса нет — коротких ссылок нет. */
export function shortLinksFromEnv(db: DatabaseExecutor): ShortLinkStore | undefined {
  const base = optionalEnv("PUBLIC_BASE_URL");
  return base ? createShortLinkStore(db, base) : undefined;
}

export type PreviewConversation = typeof previewConversations.$inferSelect;

/** Куда инструменты консультанта пишут состояние разговора: превью — в `preview_conversations`, боевой разговор — в прохождение. */
export interface ConversationStore {
  finish(chatId: string, summary: DialogSummary): Promise<void>;
  /** Ответ человека на предложение продукта; `day` — день программы, в который прозвучало предложение. */
  saleAnswer(chatId: string, answer: { reason: SaleReason; firm: boolean }, day: number): Promise<void>;
  /** Что человек ответил на предложение продукта: для строки продажи в хвосте хода. */
  saleState(chatId: string): Promise<SaleAnswer | null>;
  /** Оплата продукта (`productLinks`): обещание, проверка, строка хвоста. Нет — инструменты оплаты ничего не узнают. */
  purchases?: PurchasePort;
  /** Короткие ссылки `/i/<код>` для `text_link`; нет (не задан PUBLIC_BASE_URL) — модель получает полную ссылку. */
  shortLinks?: Pick<ShortLinkStore, "shorten">;
}

export async function startPreviewConversation(
  db: DatabaseExecutor,
  input: { chatId: string; leadMagnetId: string },
): Promise<void> {
  await db.insert(previewConversations).values(input).onConflictDoNothing();
}

export async function readPreviewConversation(db: DatabaseExecutor, chatId: string): Promise<PreviewConversation | null> {
  const [row] = await db.select().from(previewConversations).where(eq(previewConversations.chatId, chatId));
  return row ?? null;
}

export function createPreviewConversationStore(db: DatabaseExecutor, shortLinks = shortLinksFromEnv(db)): ConversationStore {
  return {
    purchases: previewPurchasePort(db),
    ...(shortLinks && { shortLinks }),
    async finish(chatId, summary) {
      await db
        .update(previewConversations)
        .set({ summary, finishedAt: sql`now()` })
        .where(eq(previewConversations.chatId, chatId));
    },
    async saleAnswer(chatId, answer, day) {
      const state = await readPreviewConversation(db, chatId);
      if (!state) throw new Error(`Нет тестового разговора ${chatId}`);
      const saleAnswer = nextSaleAnswer(state.saleAnswer ?? null, answer, day);
      await db.update(previewConversations).set({ saleAnswer }).where(eq(previewConversations.chatId, chatId));
    },
    async saleState(chatId) {
      return (await readPreviewConversation(db, chatId))?.saleAnswer ?? null;
    },
  };
}
