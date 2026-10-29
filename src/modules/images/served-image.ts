import { readFile } from "node:fs/promises";
import { uploadsDir } from "../mailings/images";
import { IMAGE_CONTENT_TYPES, imageFilePath, type ImageExtension } from "./image-file";

const NOT_FOUND = () => new Response("Not found", { status: 404 });

/** Ответ на запрос картинки архива: файл из папки загрузок. Имя у файла уникально и не меняется, поэтому кэш долгий. */
export async function imageResponse(fileName: string, dir = uploadsDir()): Promise<Response> {
  const path = imageFilePath(fileName, dir);
  if (!path) return NOT_FOUND();
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return NOT_FOUND();
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1) as ImageExtension;
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": IMAGE_CONTENT_TYPES[extension], "cache-control": "private, max-age=31536000, immutable" },
  });
}
