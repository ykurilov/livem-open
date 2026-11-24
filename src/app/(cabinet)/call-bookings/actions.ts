"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import { cancelCallByExpert, disconnectCallNoticeBot, startCallNoticeConnect } from "@/modules/booking";
import { createChannelAdapters } from "@/modules/channels";
import { INBOX_REPLY_LIMIT } from "@/modules/inbox";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { getWebQueue } from "@/modules/platform/queue";
import { isUuid } from "@/modules/platform/uuid";

export interface CallBookingActionState {
  error?: string;
  done?: boolean;
  /** «Подключить»: ссылка на бота, по ней эксперт нажимает «Старт». */
  link?: string;
}

/** Эксперт отменяет запись: с галочкой человеку уходит сообщение (своими словами или стандартное), в бот эксперта — уведомление. */
export async function cancelCallBookingAction(bookingId: string, _previous: CallBookingActionState, formData: FormData): Promise<CallBookingActionState> {
  const user = await requireUser();
  if (!isUuid(bookingId)) return { error: "Запись не найдена — обновите страницу" };
  const tellPerson = formData.get("tellPerson") === "on";
  const text = String(formData.get("text") ?? "").trim();
  if (tellPerson && text.length > INBOX_REPLY_LIMIT) return { error: `Сообщение длиннее ${INBOX_REPLY_LIMIT} знаков — сократите его` };
  const cancelled = await cancelCallByExpert(
    { db: getDatabase().db, queue: await getWebQueue(), clock: systemClock },
    bookingId,
    { tellPerson, ...(text && { text }), ...(user.name && { staffName: user.name }) },
  );
  revalidatePath("/call-bookings");
  revalidatePath("/calls");
  return cancelled ? { done: true } : { error: "Запись уже отменена или перенесена" };
}

export async function startCallNoticeConnectAction(botId: string, _previous: CallBookingActionState): Promise<CallBookingActionState> {
  await requireUser();
  if (!isUuid(botId)) return { error: "Бот не найден — обновите страницу" };
  const { link } = await startCallNoticeConnect(getDatabase().db, createChannelAdapters(), botId);
  revalidatePath("/call-bookings");
  return { link };
}

export async function disconnectCallNoticeAction(botId: string, _previous: CallBookingActionState): Promise<CallBookingActionState> {
  await requireUser();
  if (!isUuid(botId)) return { error: "Бот не найден — обновите страницу" };
  await disconnectCallNoticeBot(getDatabase().db, botId);
  revalidatePath("/call-bookings");
  return { done: true };
}
