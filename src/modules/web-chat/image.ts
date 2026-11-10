import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { IMAGE_CONTENT_TYPES, type ImageExtension } from "../images/image-file";
import { uploadsDir } from "../mailings/images";

/** Картинки, которые уходят в веб-чат: из архива (`image-…`) и рассылок (`mailing-…`); обе лежат в папке загрузок. */
const WEB_CHAT_IMAGE_NAME = /^(image|mailing)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

const NOT_FOUND = () => new Response("Not found", { status: 404 });

/** Файл картинки исходящего по его пути; ищется только по имени в папке загрузок, чужое имя — 404. */
export async function webChatImageResponse(imagePath: string, dir = uploadsDir()): Promise<Response> {
  const name = basename(imagePath);
  const match = WEB_CHAT_IMAGE_NAME.exec(name);
  if (!match) return NOT_FOUND();
  const bytes = await readFile(join(dir, name)).catch(() => null);
  if (!bytes) return NOT_FOUND();
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": IMAGE_CONTENT_TYPES[match[2] as ImageExtension], "cache-control": "private, max-age=31536000, immutable" },
  });
}
