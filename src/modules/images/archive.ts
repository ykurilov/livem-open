import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../platform/db";
import { uploadsDir } from "../mailings/images";
import { imageFileName, imageSizeProblem, readImageFile } from "./image-file";
import { images } from "./schema";

export type ExpertImage = Pick<typeof images.$inferSelect, "id" | "title" | "description" | "fileName" | "width" | "height">;

export interface ImageInput {
  title: string;
  description: string;
}

export class InvalidImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImageError";
  }
}

/** Консультант всё равно видит не больше 300 знаков описания. */
export const MAX_IMAGE_DESCRIPTION_LENGTH = 300;
/** Telegram принимает фото до 10 МБ. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const imageColumns = {
  id: images.id,
  title: images.title,
  description: images.description,
  fileName: images.fileName,
  width: images.width,
  height: images.height,
};

function checkedInput(input: ImageInput): ImageInput {
  const title = input.title.trim();
  const description = input.description.trim();
  if (!title) throw new InvalidImageError("Напишите название картинки");
  if (!description) throw new InvalidImageError("Напишите, когда её показывать: по этому описанию консультант её находит");
  if (description.length > MAX_IMAGE_DESCRIPTION_LENGTH) {
    throw new InvalidImageError(`Описание длиннее ${MAX_IMAGE_DESCRIPTION_LENGTH} знаков — сократите до пары фраз`);
  }
  return { title, description };
}

/** Проверяет и кладёт файл в папку загрузок под новым именем. */
async function savedFile(file: { bytes: Uint8Array }, dir: string): Promise<Pick<ExpertImage, "fileName" | "width" | "height">> {
  if (file.bytes.byteLength > IMAGE_MAX_BYTES) throw new InvalidImageError("Картинка больше 10 МБ");
  const info = readImageFile(file.bytes);
  if (!info) throw new InvalidImageError("Подойдёт картинка PNG, JPG, GIF или WebP");
  const sizeProblem = imageSizeProblem(info.width, info.height);
  if (sizeProblem) throw new InvalidImageError(sizeProblem);
  const fileName = imageFileName(info.extension);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), file.bytes);
  return { fileName, width: info.width, height: info.height };
}

/** Картинки архива без удалённых, новые сверху. */
export async function listImages(db: DatabaseExecutor): Promise<ExpertImage[]> {
  return db.select(imageColumns).from(images).where(isNull(images.deletedAt)).orderBy(desc(images.createdAt));
}

/** Неудалённые картинки с этими id; порядок — как в `ids`, неизвестные пропускаются. */
export async function getImages(db: DatabaseExecutor, ids: readonly string[]): Promise<ExpertImage[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(imageColumns)
    .from(images)
    .where(and(inArray(images.id, [...ids]), isNull(images.deletedAt)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Запись в базу с новым файлом: не записалось — файл удаляется, чтобы не лежал на диске без картинки в архиве. */
async function withSavedFile<T>(saved: { fileName: string } | null, dir: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (saved) await rm(join(dir, saved.fileName), { force: true });
    throw error;
  }
}

export async function createImage(db: DatabaseExecutor, input: ImageInput, file: { bytes: Uint8Array }, dir = uploadsDir()): Promise<ExpertImage> {
  const checked = checkedInput(input);
  const saved = await savedFile(file, dir);
  const [created] = await withSavedFile(saved, dir, () => db.insert(images).values({ ...checked, ...saved }).returning(imageColumns));
  return created!;
}

/**
 * Правка названия и описания; `file` — новая картинка вместо старой. Старый файл остаётся на диске: его показ уже
 * лежит в истории разговоров.
 */
export async function updateImage(
  db: DatabaseExecutor,
  id: string,
  input: ImageInput,
  file: { bytes: Uint8Array } | null,
  dir = uploadsDir(),
): Promise<ExpertImage> {
  const checked = checkedInput(input);
  const [existing] = await db.select({ id: images.id }).from(images).where(and(eq(images.id, id), isNull(images.deletedAt)));
  if (!existing) throw new InvalidImageError("Картинка не найдена — обновите страницу");
  const saved = file && (await savedFile(file, dir));
  return withSavedFile(saved, dir, async () => {
    const [updated] = await db
      .update(images)
      .set({ ...checked, ...saved })
      .where(and(eq(images.id, id), isNull(images.deletedAt)))
      .returning(imageColumns);
    if (!updated) throw new InvalidImageError("Картинка не найдена — обновите страницу");
    return updated;
  });
}

/** Картинка пропадает из архива и из поиска консультанта; файл остаётся для истории. Повторное удаление ничего не меняет. */
export async function deleteImage(db: DatabaseExecutor, id: string, at: Date): Promise<void> {
  await db
    .update(images)
    .set({ deletedAt: at })
    .where(and(eq(images.id, id), isNull(images.deletedAt)));
}
