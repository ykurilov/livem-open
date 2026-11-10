import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { imageSizeProblem, readImageFile } from "../images/image-file";
import { IMAGE_MAX_BYTES } from "../images/image-limits";
import { optionalEnv } from "../platform/env";

export const MAILING_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES;

export class MailingImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailingImageError";
  }
}

/** Где лежат картинки рассылок. Папку видят и веб, и работник (общий том `/app/data`). */
export function uploadsDir(env: Record<string, string | undefined> = process.env): string {
  return optionalEnv("UPLOADS_DIR", env) ?? (env.NODE_ENV === "production" ? "/app/data/uploads" : resolve("data/uploads"));
}

/** Сохраняет одну картинку рассылки под новым именем и возвращает путь на диске. */
export async function saveMailingImage(file: { name: string; bytes: Uint8Array }, dir = uploadsDir()): Promise<string> {
  if (file.bytes.byteLength > MAILING_IMAGE_MAX_BYTES) throw new MailingImageError("Картинка больше 10 МБ");
  const info = readImageFile(file.bytes);
  if (!info) throw new MailingImageError("Подойдёт картинка PNG, JPG, GIF или WebP");
  const sizeProblem = imageSizeProblem(info.width, info.height);
  if (sizeProblem) throw new MailingImageError(sizeProblem);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `mailing-${randomUUID()}.${info.extension}`);
  await writeFile(path, file.bytes);
  return path;
}

/** Удаляет картинку рассылки. Трогает только файлы в папке картинок; уже удалённый файл — не ошибка. */
export async function removeMailingImage(path: string, dir = uploadsDir()): Promise<void> {
  if (dirname(resolve(path)) !== resolve(dir)) return;
  await rm(path, { force: true });
}
