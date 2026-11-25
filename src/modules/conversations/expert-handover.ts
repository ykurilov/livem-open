import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { queueAgentHandoverNotices } from "../booking/notices";
import { AGENT_HANDOVER_PREFIX, type ExpertHandoverPort } from "../consultant";
import { inboxThreads } from "../inbox/schema";
import { leadMagnets } from "../lead-magnets/schema";
import { people } from "../people/schema";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { continuesAfterEnd } from "./after-end";
import { passages } from "./schema";

/**
 * Передача вопроса вернувшегося человека эксперту в живом разговоре: у прохождения — пометка с выжимкой, переписка —
 * во «Входящих» как ждущая ответа, эксперту — уведомление в подключённые боты. Разговор не меняется: следующее
 * сообщение человека — снова агенту.
 */
export function createExpertHandoverPort(deps: { db: Database; queue: JobEnqueuer; clock: Clock }): ExpertHandoverPort {
  return {
    async handOver({ chatId }, summary) {
      const [passage] = await deps.db.select().from(passages).where(eq(passages.chatId, chatId));
      if (!passage || !continuesAfterEnd(passage)) return { ok: false, reason: "not_after_end" };
      const now = deps.clock.now();
      await deps.db.transaction(async (tx) => {
        await tx
          .update(passages)
          .set({ handedToExpertAt: now, handoverReason: `${AGENT_HANDOVER_PREFIX}${summary}` })
          .where(eq(passages.id, passage.id));
        // Переписка ждёт ответа эксперта, даже если все сообщения человека ушли агенту
        await tx.insert(inboxThreads).values({ personId: passage.personId }).onConflictDoNothing();
        await tx
          .update(inboxThreads)
          .set({ unansweredCount: sql`greatest(${inboxThreads.unansweredCount}, 1)`, lastMessageAt: now })
          .where(eq(inboxThreads.personId, passage.personId));
      });
      const [person] = await deps.db.select({ displayName: people.displayName }).from(people).where(eq(people.id, passage.personId));
      const [lead] = await deps.db.select({ draft: leadMagnets.draft }).from(leadMagnets).where(eq(leadMagnets.id, passage.leadMagnetId));
      const who = person?.displayName?.trim() || "Без имени";
      const from = lead?.draft.name ? `\nЛидмагнит: «${lead.draft.name}»` : "";
      await queueAgentHandoverNotices(deps, {
        key: `${passage.id}:${createHash("sha256").update(summary).digest("hex").slice(0, 16)}`,
        text: `Агент передал вам вопрос: ${who}\n${summary}${from}\nОтветьте во «Входящих».`,
      });
      return { ok: true };
    },
  };
}
