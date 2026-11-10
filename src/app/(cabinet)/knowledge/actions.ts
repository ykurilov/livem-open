"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import { InvalidKnowledgeError, createKnowledgeBase, deleteKnowledgeBase, editKnowledgeBase, type KnowledgeFile } from "@/modules/knowledge";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { isUuid } from "@/modules/platform/uuid";

const NOT_FOUND = "База знаний не найдена — обновите страницу";

export interface KnowledgeActionState {
  error?: string;
  done?: boolean;
}

/** Выбранный файл формы; не выбран — `null`. */
async function fileOf(formData: FormData): Promise<KnowledgeFile | null> {
  const file = formData.get("file");
  return file instanceof File && file.name ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
}

/** Новая база (`baseId` = null, файл обязателен) или правка: новый файл заменяет текст, без файла остаётся прежний. */
export async function saveKnowledgeAction(baseId: string | null, _previous: KnowledgeActionState, formData: FormData): Promise<KnowledgeActionState> {
  await requireUser();
  if (baseId !== null && !isUuid(baseId)) return { error: NOT_FOUND };
  const title = typeof formData.get("title") === "string" ? String(formData.get("title")) : "";
  const file = await fileOf(formData);
  if (baseId === null && !file) return { error: "Выберите текстовый файл" };
  if (baseId !== null && !title.trim()) return { error: "Напишите название базы знаний" };
  const { db } = getDatabase();
  try {
    if (baseId === null) await createKnowledgeBase(db, { title }, file!);
    else await editKnowledgeBase(db, baseId, { title, ...(file && { file }) });
  } catch (error) {
    if (error instanceof InvalidKnowledgeError) return { error: error.message };
    throw error;
  }
  revalidatePath("/knowledge");
  return { done: true };
}

export async function deleteKnowledgeAction(baseId: string, _previous: KnowledgeActionState): Promise<KnowledgeActionState> {
  await requireUser();
  if (!isUuid(baseId)) return { error: NOT_FOUND };
  await deleteKnowledgeBase(getDatabase().db, baseId, systemClock.now());
  revalidatePath("/knowledge");
  return { done: true };
}
