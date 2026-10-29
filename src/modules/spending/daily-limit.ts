import type { ChatStorage, ModelCatalog, SpendingLimits } from "@ykurilov/agent-chat-core";
import { createSpendingLimits } from "@ykurilov/agent-chat-limits";
import { and, eq, isNotNull } from "drizzle-orm";
import { passages } from "../conversations/schema";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { AGENT_TIME_ZONE } from "../platform/models-catalog";
import { readSettings } from "../platform/settings";
import { nextLocalTime } from "../program/calendar";
import { FIRST_MESSAGES_QUIET_HOURS } from "../flows/runtime";

/** Готовый текст человеку, исчерпавшему дневной лимит: модель не вызывается. */
export const DAILY_LIMIT_TEXT = "На сегодня мне нужно сделать паузу. Продолжим завтра утром — я напишу вам сам.";

export interface DailyLimitDependencies {
  db: Database;
  chatStorage: ChatStorage;
  catalog: ModelCatalog;
  clock: Clock;
}

/**
 * Дневной лимит на человека: расход всех его чатов за сутки по Москве. Только у боевых ходов консультанта;
 * тестовый разговор эксперта (превью) идёт без лимитов. Лимит читается из настроек на каждую проверку —
 * поднятый лимит действует сразу.
 */
export function createDailyLimits(deps: DailyLimitDependencies): SpendingLimits {
  return createSpendingLimits({
    storage: deps.chatStorage,
    catalog: deps.catalog,
    budget: async () => ({ user: Number((await readSettings(deps.db)).dailyLimitUsd) }),
    period: "day",
    timeZone: AGENT_TIME_ZONE,
    now: () => deps.clock.now(),
  });
}

/**
 * Когда продолжить разговор после лимита: утро после обнуления расхода — конец ночи сообщений первым (9:00 по Москве).
 * У программы на несколько дней утро — её утреннее время по поясу человека (`program`).
 * SDK не назвал время обнуления — расход дня обнуляется в полночь по Москве.
 */
export async function morningAfter(
  deps: Pick<DailyLimitDependencies, "db" | "clock">,
  resetsAt: string | null,
  program?: { morningAt: string; timeZone: string | null },
): Promise<Date> {
  const reset = resetsAt ? new Date(resetsAt) : deps.clock.nextMskTime("00:00", deps.clock.now());
  if (program) return nextLocalTime(program.morningAt, reset, program.timeZone);
  return deps.clock.nextMskTime(FIRST_MESSAGES_QUIET_HOURS.to, reset);
}

/**
 * Дневной лимит подняли: отложенным до утра разговорам — ход сразу. Без ключа одиночки: его держит утренняя задача,
 * она потом найдёт, что отвечать нечего. Двух ходов разом не будет — на одну пачку SDK начинает один ход.
 */
export async function resumeDailyLimitedPassages(deps: { db: Database; queue: JobEnqueuer; clock: Clock }): Promise<number> {
  const postponed = await deps.db
    .select({ id: passages.id })
    .from(passages)
    .where(and(isNotNull(passages.dailyLimitPausedAt), eq(passages.status, "active")));
  for (const { id } of postponed) {
    await deps.queue.enqueue("inbound-turn", { passageId: id });
    await deps.db.update(passages).set({ dailyLimitPausedAt: null }).where(eq(passages.id, id));
  }
  return postponed.length;
}
