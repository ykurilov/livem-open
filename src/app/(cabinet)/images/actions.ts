"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import { InvalidImageError, createImage, deleteImage, updateImage } from "@/modules/images";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { isUuid } from "@/modules/platform/uuid";

const IMAGE_NOT_FOUND = "Картинка не найдена — обновите страницу";

export interface ImageActionState {
  error?: string;
  done?: boolean;
}

const textOf = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/** Выбранный файл формы; не выбран — `null`. */
async function fileOf(formData: FormData): Promise<{ bytes: Uint8Array } | null> {
  const file = formData.get("file");
  return file instanceof File && file.size > 0 ? { bytes: new Uint8Array(await file.arrayBuffer()) } : null;
}

/** Новая картинка (`imageId` = null, файл обязателен) или правка: новый файл заменяет картинку, без файла остаётся прежняя. */
export async function saveImageAction(imageId: string | null, _previous: ImageActionState, formData: FormData): Promise<ImageActionState> {
  await requireUser();
  if (imageId !== null && !isUuid(imageId)) return { error: IMAGE_NOT_FOUND };
  const input = { title: textOf(formData, "title"), description: textOf(formData, "description") };
  const file = await fileOf(formData);
  if (imageId === null && !file) return { error: "Выберите картинку" };
  const { db } = getDatabase();
  try {
    if (imageId === null) await createImage(db, input, file!);
    else await updateImage(db, imageId, input, file);
  } catch (error) {
    if (error instanceof InvalidImageError) return { error: error.message };
    throw error;
  }
  revalidatePath("/images");
  return { done: true };
}

export async function deleteImageAction(imageId: string, _previous: ImageActionState): Promise<ImageActionState> {
  await requireUser();
  if (!isUuid(imageId)) return { error: IMAGE_NOT_FOUND };
  await deleteImage(getDatabase().db, imageId, systemClock.now());
  revalidatePath("/images");
  return { done: true };
}
