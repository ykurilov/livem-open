import { and, eq, type SQL } from "drizzle-orm";
import type { DatabaseExecutor } from "../platform/db";
import { passages, type PassageStatus } from "./schema";

export type PassageEndStatus = Exclude<PassageStatus, "active">;

/** Закрывает идущие прохождения из условия `which`: итог, время конца, напоминаний больше нет. Уже закрытые не трогает. */
export async function endActivePassages(tx: DatabaseExecutor, which: SQL, status: PassageEndStatus, at: Date): Promise<void> {
  await tx
    .update(passages)
    .set({ status, endedAt: at, nextReminderAt: null })
    .where(and(which, eq(passages.status, "active")));
}
