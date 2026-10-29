"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import { InvalidFieldError, deleteField, renameField } from "@/modules/people";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { isUuid } from "@/modules/platform/uuid";

const FIELD_NOT_FOUND = "Поле не найдено — обновите страницу";

export interface FieldActionState {
  error?: string;
  done?: boolean;
}

export async function renameFieldAction(fieldId: string, _previous: FieldActionState, formData: FormData): Promise<FieldActionState> {
  await requireUser();
  if (!isUuid(fieldId)) return { error: FIELD_NOT_FOUND };
  const name = formData.get("name");
  if (typeof name !== "string") return { error: "Напишите новое имя" };
  try {
    await renameField(getDatabase().db, fieldId, name);
  } catch (error) {
    if (error instanceof InvalidFieldError) return { error: error.message };
    throw error;
  }
  revalidatePath("/fields");
  return { done: true };
}

/** Удаляет поле; значения у людей переходят в свободные факты. */
export async function deleteFieldAction(fieldId: string, _previous: FieldActionState): Promise<FieldActionState> {
  await requireUser();
  if (!isUuid(fieldId)) return { error: FIELD_NOT_FOUND };
  try {
    await deleteField(getDatabase().db, fieldId, systemClock.now());
  } catch (error) {
    if (error instanceof InvalidFieldError) return { error: error.message };
    throw error;
  }
  revalidatePath("/fields");
  return { done: true };
}
