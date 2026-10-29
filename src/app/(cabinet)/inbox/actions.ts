"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import { InboxReplyError, replyFromInbox } from "@/modules/inbox";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { getWebQueue } from "@/modules/platform/queue";
import { isUuid } from "@/modules/platform/uuid";

export interface InboxReplyState {
  error?: string;
  sent?: boolean;
}

/** Ответ эксперта уходит человеку от имени бота. */
export async function replyAction(_previous: InboxReplyState, formData: FormData): Promise<InboxReplyState> {
  const user = await requireUser();
  const personId = formData.get("personId");
  const text = formData.get("text");
  const seenUpTo = new Date(String(formData.get("seenUpTo")));
  const requestId = formData.get("requestId");
  if (typeof personId !== "string" || !isUuid(personId) || typeof text !== "string" || typeof requestId !== "string" || Number.isNaN(seenUpTo.getTime())) {
    return { error: "Форма устарела — обновите страницу" };
  }
  try {
    await replyFromInbox({ db: getDatabase().db, queue: await getWebQueue(), clock: systemClock }, { personId, text, seenUpTo, requestId, ...(user.name && { staffName: user.name }) });
  } catch (error) {
    if (error instanceof InboxReplyError) return { error: error.message };
    throw error;
  }
  // Счётчик в меню — во всём кабинете
  revalidatePath("/", "layout");
  return { sent: true };
}
