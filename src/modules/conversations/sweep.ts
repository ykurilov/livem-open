import { and, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { requeueStuckOutbound } from "../channels";
import { requeuePendingChatMigrations } from "../flows/chat-migration";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { recoverPurchaseReactions } from "../purchases/reactions";
import { inboundMessages, passages } from "./schema";
import { delayedTurnKey, retryTurnKey } from "./turn";

/** Раз в минуту (cron, UTC). */
export const STUCK_SWEEP_CRON = "* * * * *";
/** Запись без задачи дольше этого — задача потерялась, а не просто ещё в пути. */
export const STUCK_AFTER_MS = 60_000;
const STUCK_BATCH = 500;
/**
 * Сообщение в разговоре без ответа дольше этого — ход мог потеряться. Отложенный ход (утро после лимита, повтор после
 * сбоя модели) держит задачу с тем же ключом: лишняя задача тогда не встанет. Лишняя задача живому ходу не мешает:
 * SDK не начнёт второй ход на ту же пачку.
 */
export const UNANSWERED_AFTER_MS = 10 * 60_000;
const FINISHED_TURN_RECOVERY_MS = 24 * 60 * 60_000;
/** Первое сообщение или меню позже этого уже некстати: человек давно ушёл, приветствие через сутки только удивит. */
export const FOLLOW_UP_RECOVERY_MS = 3 * 60 * 60_000;

export interface SweepDependencies {
  db: Database;
  queue: JobEnqueuer;
  clock: Clock;
}

/**
 * Задача `stuck-sweep` (конституция I, лид не теряется): процесс упал между записью и постановкой задачи —
 * входящее осталось неразобранным, исходящее неотправленным. Подмётчик ставит им задачи заново;
 * разбор и отправка идемпотентны, лишняя задача ничего не задвоит.
 */
export async function sweepStuckWork(deps: SweepDependencies): Promise<void> {
  const overdueBefore = new Date(deps.clock.now().getTime() - STUCK_AFTER_MS);
  const inbound = await deps.db
    .select({ id: inboundMessages.id })
    .from(inboundMessages)
    .where(and(isNull(inboundMessages.processedAt), lt(inboundMessages.receivedAt, overdueBefore)))
    .limit(STUCK_BATCH);
  for (const { id } of inbound) await deps.queue.enqueue("inbound-route", { inboundMessageId: id });
  const followUps = await requeueUnfinishedFollowUps(deps, overdueBefore);
  const outbound = await requeueStuckOutbound(deps, overdueBefore);
  const turns = await requeueLostTurns(deps);
  const purchases = await recoverPurchaseReactions(deps);
  const migrations = await requeuePendingChatMigrations(deps);
  if (inbound.length || followUps || outbound || turns || purchases || migrations)
    console.warn(
      `Подмётчик: заново поставлено входящих — ${inbound.length}, действий после решения — ${followUps}, исходящих — ${outbound}, ходов — ${turns}, покупок — ${purchases}, переводов — ${migrations}`,
    );
}

/**
 * Решение о входящем записано, а действия после него (первое сообщение, закрепление сценария, меню) не выполнились:
 * задача исчерпала повторы, пока лежала база или очередь. Повтор разбора решение не меняет, только довыполняет действия.
 */
async function requeueUnfinishedFollowUps(deps: SweepDependencies, overdueBefore: Date): Promise<number> {
  const unfinished = await deps.db
    .select({ id: inboundMessages.id })
    .from(inboundMessages)
    .where(
      and(
        isNotNull(inboundMessages.processedAt),
        isNull(inboundMessages.followedUpAt),
        lt(inboundMessages.processedAt, overdueBefore),
        gt(inboundMessages.processedAt, new Date(deps.clock.now().getTime() - FOLLOW_UP_RECOVERY_MS)),
      ),
    )
    .limit(STUCK_BATCH);
  for (const { id } of unfinished) await deps.queue.enqueue("inbound-route", { inboundMessageId: id });
  return unfinished.length;
}

/**
 * Ход, чья задача пропала (исчерпала повторы очереди, пока лежала база): человек ждёт ответа, а задачи нет.
 * Задача ставится с ключом отложенного хода: если он уже ждёт своего часа, вторая не встанет. Ход падал — ключ повтора:
 * ждущий повтор держит паузу между попытками, а утренняя задача пропавший повтор до утра не держит.
 * Разговор, закрытый этим же ходом (итог и прощание брошенной пачки не дошли), тоже доводится — в пределах суток.
 */
async function requeueLostTurns(deps: SweepDependencies): Promise<number> {
  const now = deps.clock.now();
  const lost = await deps.db
    .selectDistinct({ passageId: passages.id, turnFailures: passages.turnFailures })
    .from(inboundMessages)
    .innerJoin(passages, eq(passages.id, inboundMessages.passageId))
    .where(
      and(
        eq(inboundMessages.route, "passage"),
        isNull(inboundMessages.answeredAt),
        lt(inboundMessages.processedAt, new Date(now.getTime() - UNANSWERED_AFTER_MS)),
        or(
          eq(passages.status, "active"),
          and(
            eq(passages.status, "completed"),
            isNotNull(inboundMessages.turnId),
            gt(passages.endedAt, new Date(now.getTime() - FINISHED_TURN_RECOVERY_MS)),
          ),
        ),
        isNull(passages.budgetPausedAt),
      ),
    )
    .limit(STUCK_BATCH);
  for (const { passageId, turnFailures } of lost)
    await deps.queue.enqueue("inbound-turn", { passageId }, { singletonKey: turnFailures > 0 ? retryTurnKey(passageId) : delayedTurnKey(passageId) });
  return lost.length;
}
