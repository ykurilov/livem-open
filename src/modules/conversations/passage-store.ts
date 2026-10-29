import { and, eq, sql } from "drizzle-orm";
import { createPreviewConversationStore, type ConversationStore } from "../consultant";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import { nextSaleAnswer } from "../program/sale-answer";
import { passagePurchasePort } from "../purchases/ports";
import type { JobEnqueuer } from "../platform/queue";
import { passages } from "./schema";

/**
 * Инструменты консультанта в боевом разговоре: итог и ответ на продажу — в прохождение. Чат без прохождения — тестовый
 * разговор «Проверки»: таймеры сценария работник ведёт и для него, а пишет он в свою строку.
 */
export function createPassageConversationStore(db: Database, clock: Clock, queue?: JobEnqueuer): ConversationStore {
  const preview = createPreviewConversationStore(db);
  const purchases = queue ? passagePurchasePort({ db, clock, queue }) : undefined;
  const passageOf = async (chatId: string) => {
    const [row] = await db.select({ id: passages.id, saleAnswer: passages.saleAnswer }).from(passages).where(eq(passages.chatId, chatId));
    return row ?? null;
  };

  return {
    // Короткие ссылки — одни на бой и «Проверку»: лидмагнит хранилище находит по чату само
    ...(preview.shortLinks && { shortLinks: preview.shortLinks }),
    // Тестовый чат без прохождения — покупки «Проверки»
    ...(purchases && {
      purchases: {
        promised: async (chatId) => ((await passageOf(chatId)) ? purchases.promised(chatId) : preview.purchases?.promised(chatId)),
        check: async (chatId, email) => ((await passageOf(chatId)) || !preview.purchases ? purchases.check(chatId, email) : preview.purchases.check(chatId, email)),
        tailLine: (chatId) => purchases.tailLine(chatId),
      },
    }),
    async finish(chatId, summary) {
      if (!(await passageOf(chatId))) return preview.finish(chatId, summary);
      // Купившему итог — «согласился», что бы ни решила модель: одним UPDATE по текущей строке, оплата посреди записи
      // итога его не разминётся (`markPurchased` ставит то же)
      const written = sql`${JSON.stringify(summary)}::jsonb`;
      await db
        .update(passages)
        .set({
          status: "completed",
          summary: sql`case when ${passages.purchasedAt} is null then ${written} else jsonb_set(${written}, '{outcome}', '"agreed"') end`,
          endedAt: clock.now(),
        })
        .where(and(eq(passages.chatId, chatId), eq(passages.status, "active")));
    },

    async saleAnswer(chatId, answer, day) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select({ id: passages.id, saleAnswer: passages.saleAnswer }).from(passages).where(eq(passages.chatId, chatId)).for("update");
        if (!row) return preview.saleAnswer(chatId, answer, day);
        await tx
          .update(passages)
          .set({ saleAnswer: nextSaleAnswer(row.saleAnswer ?? null, answer, day) })
          .where(eq(passages.id, row.id));
      });
    },

    async saleState(chatId) {
      const passage = await passageOf(chatId);
      return passage ? (passage.saleAnswer ?? null) : preview.saleState(chatId);
    },
  };
}
