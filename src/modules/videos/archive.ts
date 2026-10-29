import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { parseVideoUrl } from "@ykurilov/agent-chat-videos";
import type { DatabaseExecutor } from "../platform/db";
import { videos, type VideoChapter } from "./schema";

export type Video = Pick<typeof videos.$inferSelect, "id" | "title" | "url" | "description" | "durationSeconds" | "chapters">;

export interface VideoInput {
  title: string;
  url: string;
  description: string;
  durationSeconds?: number | null;
  chapters?: VideoChapter[];
}

export class InvalidVideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVideoError";
  }
}

/** Консультант всё равно видит не больше 300 знаков описания. */
export const MAX_DESCRIPTION_LENGTH = 300;

const videoColumns = {
  id: videos.id,
  title: videos.title,
  url: videos.url,
  description: videos.description,
  durationSeconds: videos.durationSeconds,
  chapters: videos.chapters,
};

function checkedInput(input: VideoInput): Required<VideoInput> {
  const title = input.title.trim();
  const url = input.url.trim();
  const description = input.description.trim();
  const durationSeconds = input.durationSeconds ?? null;
  const chapters = (input.chapters ?? []).map((chapter) => ({ title: chapter.title.trim(), startSeconds: chapter.startSeconds }));
  if (!title) throw new InvalidVideoError("Напишите название ролика");
  if (!parseVideoUrl(url)) {
    throw new InvalidVideoError("Нужна ссылка на ролик YouTube или Kinescope, например https://youtu.be/… или https://kinescope.io/…");
  }
  if (!description) throw new InvalidVideoError("Напишите, о чём ролик: по этому описанию консультант его находит");
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new InvalidVideoError(`Описание длиннее ${MAX_DESCRIPTION_LENGTH} знаков — сократите до пары фраз`);
  }
  if (durationSeconds !== null && (!Number.isInteger(durationSeconds) || durationSeconds <= 0)) {
    throw new InvalidVideoError("Длительность должна быть больше нуля");
  }
  for (const chapter of chapters) {
    if (!chapter.title) throw new InvalidVideoError("У главы должно быть название");
    if (!Number.isInteger(chapter.startSeconds) || chapter.startSeconds < 0) throw new InvalidVideoError(`Неверное начало главы «${chapter.title}»`);
    if (durationSeconds !== null && chapter.startSeconds >= durationSeconds) {
      throw new InvalidVideoError(`Глава «${chapter.title}» начинается позже конца ролика`);
    }
  }
  return { title, url, description, durationSeconds, chapters };
}

/** Ролики архива без удалённых, новые сверху. */
export async function listVideos(db: DatabaseExecutor): Promise<Video[]> {
  return db.select(videoColumns).from(videos).where(isNull(videos.deletedAt)).orderBy(desc(videos.createdAt));
}

/** Неудалённые ролики с этими id; порядок — как в `ids`, неизвестные пропускаются. */
export async function getVideos(db: DatabaseExecutor, ids: readonly string[]): Promise<Video[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(videoColumns)
    .from(videos)
    .where(and(inArray(videos.id, [...ids]), isNull(videos.deletedAt)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export async function createVideo(db: DatabaseExecutor, input: VideoInput): Promise<Video> {
  const [created] = await db.insert(videos).values(checkedInput(input)).returning(videoColumns);
  return created!;
}

export async function updateVideo(db: DatabaseExecutor, id: string, input: VideoInput): Promise<Video> {
  const [updated] = await db
    .update(videos)
    .set(checkedInput(input))
    .where(and(eq(videos.id, id), isNull(videos.deletedAt)))
    .returning(videoColumns);
  if (!updated) throw new InvalidVideoError("Ролик не найден — обновите страницу");
  return updated;
}

/** Ролик пропадает из архива и из поиска консультанта. Повторное удаление ничего не меняет. */
export async function deleteVideo(db: DatabaseExecutor, id: string, at: Date): Promise<void> {
  await db
    .update(videos)
    .set({ deletedAt: at })
    .where(and(eq(videos.id, id), isNull(videos.deletedAt)));
}
