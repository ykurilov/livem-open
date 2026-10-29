import { eq, isNotNull } from "drizzle-orm";
import { passages } from "../conversations/schema";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";

/**
 * Аварийная остановка: человек, написавший во время остановки, один раз получает этот текст без модели.
 * После подъёма бюджета или в новом месяце бот пишет ему первым.
 */
export const BUDGET_PAUSE_TEXT = "Сейчас не могу ответить сразу. Отвечу чуть позже — напишу вам сам.";

/**
 * Бюджет подняли или начался новый месяц: каждому остановленному разговору — ход на накопившиеся сообщения,
 * бот пишет человеку первым. Задача ставится до снятия отметки: упадём между ними — повтор найдёт отметку снова.
 */
export async function resumeBudgetPausedPassages(deps: { db: Database; queue: JobEnqueuer; clock: Clock }): Promise<number> {
  const paused = await deps.db.select({ id: passages.id }).from(passages).where(isNotNull(passages.budgetPausedAt));
  for (const { id } of paused) {
    await deps.queue.enqueue("inbound-turn", { passageId: id }, { singletonKey: id });
    await deps.db.update(passages).set({ budgetPausedAt: null }).where(eq(passages.id, id));
  }
  if (paused.length > 0) console.warn(`Бюджет: возобновлено разговоров после аварийной остановки — ${paused.length}`);
  return paused.length;
}
