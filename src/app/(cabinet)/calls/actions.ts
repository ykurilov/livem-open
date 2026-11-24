"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import {
  deleteCallWindow,
  describeOutsideBookings,
  saveCallWindow,
  updateCallCalendar,
  type CalendarChangeResult,
  type OutsideBooking,
} from "@/modules/booking";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { isUuid } from "@/modules/platform/uuid";

export interface CalendarActionState {
  error?: string;
  saved?: boolean;
  /** Записи, которые окажутся вне окон: изменение ждёт согласия эксперта. */
  outside?: OutsideBooking[];
}

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
};

async function finish<T>(result: CalendarChangeResult<T>): Promise<CalendarActionState> {
  if (result.ok) {
    revalidatePath("/calls");
    revalidatePath("/call-bookings");
    return { saved: true };
  }
  if ("error" in result) return { error: result.error };
  return { outside: await describeOutsideBookings(getDatabase().db, result.outside) };
}

/** Пояс и длительность созвона. */
export async function saveCallCalendarAction(_previous: CalendarActionState, formData: FormData): Promise<CalendarActionState> {
  await requireUser();
  const result = await updateCallCalendar(getDatabase().db, { timeZone: text(formData, "timeZone"), callMinutes: Number(text(formData, "callMinutes")) }, { now: systemClock.now(), confirm: formData.get("confirm") === "1" });
  return finish(result);
}

/** Добавить или поправить окно. */
export async function saveCallWindowAction(windowId: string | null, _previous: CalendarActionState, formData: FormData): Promise<CalendarActionState> {
  await requireUser();
  if (windowId !== null && !isUuid(windowId)) return { error: "Окно не найдено — обновите страницу" };
  const result = await saveCallWindow(
    getDatabase().db,
    {
      ...(windowId && { id: windowId }),
      date: text(formData, "date"),
      startTime: text(formData, "startTime"),
      endTime: text(formData, "endTime"),
      weekly: formData.get("weekly") === "on",
    },
    { now: systemClock.now(), confirm: formData.get("confirm") === "1" },
  );
  return finish(result);
}

export async function deleteCallWindowAction(windowId: string, _previous: CalendarActionState, formData: FormData): Promise<CalendarActionState> {
  await requireUser();
  if (!isUuid(windowId)) return { error: "Окно не найдено — обновите страницу" };
  const result = await deleteCallWindow(getDatabase().db, windowId, { now: systemClock.now(), confirm: formData.get("confirm") === "1" });
  return finish(result);
}
