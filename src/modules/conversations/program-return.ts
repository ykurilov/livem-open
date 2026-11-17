import { and, eq, inArray } from "drizzle-orm";
import { getVersion } from "../lead-magnets";
import { leadMagnetVersions } from "../lead-magnets/schema";
import type { Person } from "../people";
import type { DatabaseExecutor } from "../platform/db";
import { passages, type PassageStatus } from "./schema";
import { afterStartOver } from "./start-over";

/** Программа, брошенная ради другого лидмагнита («не завершил»), не закончилась: возврат по ссылке начинает её заново. */
const PROGRAM_END_STATUSES: PassageStatus[] = ["completed", "term_ended", "blocked"];

/**
 * У человека было прохождение этого лидмагнита на снимке с программой, и оно закончилось: согласием, сроком или
 * блокировкой. Прохождения до «Начать заново» не считаются.
 */
export async function programEnded(tx: DatabaseExecutor, person: Pick<Person, "id" | "conversationsResetAt">, leadMagnetId: string): Promise<boolean> {
  const ended = await tx
    .select({ settings: leadMagnetVersions.settings })
    .from(passages)
    .innerJoin(leadMagnetVersions, eq(leadMagnetVersions.id, passages.snapshotId))
    .where(
      afterStartOver(
        passages.startedAt,
        person.conversationsResetAt,
        and(eq(passages.personId, person.id), eq(passages.leadMagnetId, leadMagnetId), inArray(passages.status, PROGRAM_END_STATUSES)),
      ),
    );
  return ended.some((row) => row.settings.flow?.schedule ?? row.settings.program);
}

/** Настройка опубликованного снимка: вернувшегося по ссылке после конца программы — начать заново. */
export async function restartsAfterProgram(tx: DatabaseExecutor, snapshotId: string): Promise<boolean> {
  const snapshot = await getVersion(tx, snapshotId);
  return snapshot?.settings.returnAfterProgram === "restart";
}

/**
 * Человек вернулся по ссылке или кнопке опубликованного лидмагнита, а его программа у него закончилась, и настройка
 * лидмагнита — «Передать мне во „Входящие“»: заново не начинаем. При «Начать заново» — `false`, как новый старт.
 */
export async function returnGoesToInbox(
  tx: DatabaseExecutor,
  person: Pick<Person, "id" | "conversationsResetAt">,
  target: { leadMagnetId: string; snapshotId: string },
): Promise<boolean> {
  return (await programEnded(tx, person, target.leadMagnetId)) && !(await restartsAfterProgram(tx, target.snapshotId));
}
