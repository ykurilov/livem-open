"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { isUuid } from "@/modules/platform/uuid";
import { InvalidVideoError, createVideo, deleteVideo, parseChapterLines, parseTimeLabel, updateVideo, type VideoInput } from "@/modules/videos";

const VIDEO_NOT_FOUND = "Ролик не найден — обновите страницу";

export interface VideoActionState {
  error?: string;
  done?: boolean;
}

const textOf = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/** Поля формы → ролик; ошибка — текстом для эксперта. */
function videoInputOf(formData: FormData): VideoInput | string {
  const durationText = textOf(formData, "duration").trim();
  const durationSeconds = durationText ? parseTimeLabel(durationText) : null;
  if (durationSeconds === null && durationText) return "Длительность — в виде 19:13 или 1:02:05";
  try {
    return {
      url: textOf(formData, "url"),
      title: textOf(formData, "title"),
      description: textOf(formData, "description"),
      durationSeconds,
      chapters: parseChapterLines(textOf(formData, "chapters")),
    };
  } catch (error) {
    return (error as Error).message;
  }
}

/** Новый ролик (`videoId` = null) или правка существующего. */
export async function saveVideoAction(videoId: string | null, _previous: VideoActionState, formData: FormData): Promise<VideoActionState> {
  await requireUser();
  if (videoId !== null && !isUuid(videoId)) return { error: VIDEO_NOT_FOUND };
  const input = videoInputOf(formData);
  if (typeof input === "string") return { error: input };
  const { db } = getDatabase();
  try {
    if (videoId === null) await createVideo(db, input);
    else await updateVideo(db, videoId, input);
  } catch (error) {
    if (error instanceof InvalidVideoError) return { error: error.message };
    throw error;
  }
  revalidatePath("/videos");
  return { done: true };
}

export async function deleteVideoAction(videoId: string, _previous: VideoActionState): Promise<VideoActionState> {
  await requireUser();
  if (!isUuid(videoId)) return { error: VIDEO_NOT_FOUND };
  await deleteVideo(getDatabase().db, videoId, systemClock.now());
  revalidatePath("/videos");
  return { done: true };
}
