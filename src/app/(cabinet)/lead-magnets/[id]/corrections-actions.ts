"use server";

import { requireUser } from "@/modules/access";
import { countPending } from "@/modules/corrections";
import { getDatabase } from "@/modules/platform/db";

/** Сколько правок ответов консультанта конструктор ещё не разобрал: число на кнопке «Разобрать правки». */
export async function pendingCorrectionsCount(leadMagnetId: string): Promise<number> {
  await requireUser();
  return countPending(getDatabase().db, leadMagnetId);
}
