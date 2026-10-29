import type { AgentFlowHandle, FlowResumeDeliveryResult } from "@ykurilov/agent-chat-flows";
import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import { BOT_REPAIR_RESEND_WINDOW_DAYS } from "../channels/outbound";
import { bots, outboundMessages } from "../channels/schema";
import { passages } from "../conversations/schema";
import type { Database } from "../platform/db";

/** Сценарий ответил, что такого ожидания уже нет или касание устарело: запись закрывается без отправки. */
export const REPAIR_WAIT_GONE_ERROR = "Сценарий больше не ждёт этого касания: не отправлено";

export interface OutreachRepairDependencies {
  db: Database;
  /** Сценарий работника: `resumeDelivery` только ставит отправку, `deliver` идёт ближайшим обходом таймеров. */
  flow: Pick<AgentFlowHandle, "resumeDelivery">;
  logError?: (message: string) => void;
}

export type OutreachRepairSummary = Record<FlowResumeDeliveryResult | "error", number>;

/**
 * Касания, ждущие починки бота (`awaiting_repair`, `delivery.ts`): бот снова работает, удалён или окно починки вышло
 * (3 суток, время базы) — сценарий отправляет тот же `messageId` своей доставкой. Запись лежит в базе, пока её не закрыла
 * доставка или ответ сценария, поэтому повтор обхода безопасен: потерянный сигнал починки, «занято» (`busy`) и падение
 * работника закрывает следующий обход. `resumed` / `pending` / `busy` — запись не трогаем; `dropped` / `not_found` —
 * сценарий касание больше не отправит, запись «не доставлено».
 */
export async function resumeOutreachAwaitingRepair(deps: OutreachRepairDependencies): Promise<OutreachRepairSummary> {
  const summary: OutreachRepairSummary = { resumed: 0, pending: 0, busy: 0, not_found: 0, dropped: 0, error: 0 };
  const windowPassed = sql<boolean>`${outboundMessages.createdAt} <= now() - make_interval(days => ${BOT_REPAIR_RESEND_WINDOW_DAYS})`;
  const waiting = await deps.db
    .select({ id: outboundMessages.id, personId: outboundMessages.personId, chatId: passages.chatId, idempotencyKey: outboundMessages.idempotencyKey })
    .from(outboundMessages)
    .innerJoin(passages, eq(passages.id, outboundMessages.passageId))
    .leftJoin(bots, eq(bots.id, outboundMessages.botId))
    .where(
      and(
        eq(outboundMessages.kind, "outreach"),
        eq(outboundMessages.status, "awaiting_repair"),
        like(outboundMessages.idempotencyKey, "flow:%"),
        // Бота нет или удалён — доставка закроет запись «не доставлено»
        or(eq(bots.status, "ok"), isNull(bots.id), sql`${bots.deletedAt} is not null`, windowPassed),
      ),
    )
    .orderBy(outboundMessages.createdAt);

  for (const row of waiting) {
    const messageId = row.idempotencyKey!.slice("flow:".length);
    try {
      const result = await deps.flow.resumeDelivery({ ownerId: row.personId, chatId: row.chatId, messageId });
      summary[result] += 1;
      if (result === "dropped" || result === "not_found") {
        await deps.db
          .update(outboundMessages)
          .set({ status: "failed", error: REPAIR_WAIT_GONE_ERROR })
          .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.status, "awaiting_repair")));
      }
    } catch (error) {
      // Сбой с одним касанием не лишает починки остальные; запись ждёт следующего обхода
      summary.error += 1;
      deps.logError?.(`[сценарий] исходящее ${row.id}: починка не возобновлена — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}
