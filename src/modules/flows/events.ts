import type { FlowFinish, FlowTransitionEvent } from "@ykurilov/agent-chat-flows";
import { and, eq, isNull, sql } from "drizzle-orm";
import { previewConversations, type StageHistoryEntry } from "../consultant/schema";
import { endActivePassages, type PassageEndStatus } from "../conversations/passage-end";
import { passages } from "../conversations/schema";
import type { Database } from "../platform/db";
import type { FlowLog } from "./flow-log";
import { DEADLINE_STATE_ID, FINAL_STATE_ID } from "./settings-to-flow";

// События сценария → наши прохождения (plan.md, раздел 2.5): на истории этапов и статусах стоят отчёты, «Лог»,
// карточка человека и откат на старую версию.

/** Конец разговора по пределу сообщений лидмагнита без программы: прохождение «завершил». */
export const MESSAGE_LIMIT_REASON = "message_limit";

/** Чем кончился разговор → статус прохождения. Своя причина приложения (`switched` и др.) — «не завершил». */
export function passageStatusOf(reason: FlowFinish["reason"]): PassageEndStatus {
  switch (reason) {
    case "final":
    case MESSAGE_LIMIT_REASON:
      return "completed";
    case "deadline":
      return "term_ended";
    case "blocked":
      return "blocked";
    default:
      return "not_completed";
  }
}

/** Запись истории этапов о переходе сценария: причина словами, кто решил, день. */
export function stageHistoryEntryOf(event: FlowTransitionEvent): StageHistoryEntry {
  return {
    stageId: event.to,
    at: new Date(event.at).toISOString(),
    ...(event.reason && { reason: event.reason.text }),
    // Старое деление «Лога»: по дню программы — таймер, остальное — решение консультанта
    by: event.decidedBy === "timer" ? "day" : "model",
    decidedBy: event.decidedBy,
    ...(event.probability !== undefined && { probability: event.probability }),
    ...(event.day && { day: event.day.day }),
  };
}

export interface LeadMagnetFlowEvents {
  onTransition(event: FlowTransitionEvent): Promise<void>;
  onFinish(event: FlowFinish): Promise<void>;
}

export function leadMagnetFlowEvents(db: Database, options: { log?: FlowLog } = {}): LeadMagnetFlowEvents {
  return {
    async onTransition(event) {
      // «Лог» видит все переходы, в том числе в «Итог» и «Срок вышел»
      await options.log?.transition(event);
      // «Итог» и «Срок вышел» — не этапы: исход разговора пишет его конец
      if (event.to === FINAL_STATE_ID || event.to === DEADLINE_STATE_ID) return;
      const entry = JSON.stringify([stageHistoryEntryOf(event)]);
      const [moved] = await db
        .update(passages)
        .set({
          currentStageId: event.to,
          stageHistory: sql`${passages.stageHistory} || ${entry}::jsonb`,
          ...(event.day && { furthestDay: sql`greatest(${passages.furthestDay}, ${event.day.day})` }),
        })
        .where(eq(passages.chatId, event.chatId))
        .returning({ id: passages.id });
      if (moved) return;
      await db
        .update(previewConversations)
        .set({ currentStageId: event.to, stageHistory: sql`${previewConversations.stageHistory} || ${entry}::jsonb` })
        .where(eq(previewConversations.chatId, event.chatId));
    },

    async onFinish(event) {
      const [passage] = await db.select({ id: passages.id }).from(passages).where(eq(passages.chatId, event.chatId));
      if (!passage) {
        await db
          .update(previewConversations)
          .set({ finishedAt: event.at })
          .where(and(eq(previewConversations.chatId, event.chatId), isNull(previewConversations.finishedAt)));
        return;
      }
      await db.transaction(async (tx) => {
        if (event.day !== null)
          await tx.update(passages).set({ furthestDay: sql`greatest(${passages.furthestDay}, ${event.day})` }).where(eq(passages.id, passage.id));
        await endActivePassages(tx, eq(passages.id, passage.id), passageStatusOf(event.reason), event.at);
      });
    },
  };
}
