import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { optionalEnv } from "../platform/env";

/** Telegram принимает фото до 10 МБ — больше и не нужно. */
export const MAILING_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

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

/** Расширение по первым байтам файла: имени и типу из браузера не верим. */
function imageExtension(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

/** Сохраняет одну картинку рассылки под новым именем и возвращает путь на диске. */
export async function saveMailingImage(file: { name: string; bytes: Uint8Array }, dir = uploadsDir()): Promise<string> {
  if (file.bytes.byteLength > MAILING_IMAGE_MAX_BYTES) throw new MailingImageError("Картинка больше 10 МБ");
  const extension = imageExtension(file.bytes);
  if (!extension) throw new MailingImageError("Подойдёт картинка PNG, JPG, GIF или WebP");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `mailing-${randomUUID()}.${extension}`);
  await writeFile(path, file.bytes);
  return path;
}

/** Удаляет картинку рассылки. Трогает только файлы в папке картинок; уже удалённый файл — не ошибка. */
export async function removeMailingImage(path: string, dir = uploadsDir()): Promise<void> {
  if (dirname(resolve(path)) !== resolve(dir)) return;
  await rm(path, { force: true });
}
