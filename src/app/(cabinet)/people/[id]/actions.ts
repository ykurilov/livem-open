"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import { startConversationsOver } from "@/modules/conversations";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { isUuid } from "@/modules/platform/uuid";

export interface StartOverState {
  error?: string;
  done?: boolean;
}

/** «Начать заново»: разговор человека закрывается, следующий «Старт» или ссылка начинают лидмагнит с чистого листа. */
export async function startOverAction(personId: string, _previous: StartOverState): Promise<StartOverState> {
  await requireUser();
  if (!isUuid(personId) || !(await startConversationsOver(getDatabase().db, personId, systemClock.now())))
    return { error: "Человек не найден — обновите страницу" };
  revalidatePath(`/people/${personId}`);
  return { done: true };
}
