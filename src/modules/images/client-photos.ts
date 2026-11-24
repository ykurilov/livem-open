import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IMAGE_CONTENT_TYPES, imageSizeProblem, readImageFile, type ImageExtension } from "./image-file";
import { IMAGE_MAX_BYTES } from "./image-limits";

/** Фото, которое посетитель веб-чата прислал сам: лежит в папке загрузок под таким именем. */
export const CLIENT_PHOTO_NAME = /^client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

export type SavedClientPhoto = { ok: true; fileName: string } | { ok: false; error: string };

/** Проверить фото посетителя (вид по байтам, размер) и положить в папку загрузок: веб и работник видят её оба. */
export async function saveClientPhoto(bytes: Uint8Array, dir: string): Promise<SavedClientPhoto> {
  if (bytes.byteLength > IMAGE_MAX_BYTES) return { ok: false, error: "Фото больше 10 МБ: пришлите поменьше" };
  const info = readImageFile(bytes);
  if (!info) return { ok: false, error: "Подойдёт фото PNG, JPG, GIF или WebP" };
  const sizeProblem = imageSizeProblem(info.width, info.height);
  if (sizeProblem) return { ok: false, error: sizeProblem };
  await mkdir(dir, { recursive: true });
  const fileName = `client-${randomUUID()}.${info.extension}`;
  await writeFile(join(dir, fileName), bytes);
  return { ok: true, fileName };
}

/** Байты фото посетителя по имени файла; чужое имя или файла нет — `null`. */
export async function readClientPhoto(fileName: string, dir: string): Promise<{ bytes: Uint8Array; filename: string; contentType: string } | null> {
  const match = CLIENT_PHOTO_NAME.exec(fileName);
  if (!match) return null;
  const bytes = await readFile(join(dir, fileName)).catch(() => null);
  return bytes ? { bytes: new Uint8Array(bytes), filename: fileName, contentType: IMAGE_CONTENT_TYPES[match[1] as ImageExtension] } : null;
}
