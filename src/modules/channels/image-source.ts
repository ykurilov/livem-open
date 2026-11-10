import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

export interface LoadedImage {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export type ImageLoadResult =
  | { ok: true; image: LoadedImage }
  | { ok: false; reason: "temporary" | "permanent"; error: string };

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Больше картинку по ссылке не качаем: она целиком в памяти работника (как предел Telegram на скачивание). */
export const IMAGE_SIZE_LIMIT = 20 * 1024 * 1024;

export const isImageLink = (path: string) => /^https?:\/\//i.test(path);

/** Картинка рассылки или лидмагнита: файл на диске или ссылка. Мессенджеру, который не берёт ссылки, нужны сами байты. */
export async function loadImage(
  imagePath: string,
  request: typeof fetch,
  timeoutMs: number,
): Promise<ImageLoadResult> {
  if (isImageLink(imagePath)) {
    let response: Response;
    try {
      response = await request(imagePath, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return { ok: false, reason: "temporary", error: `Не удалось скачать картинку: ${messageOf(error)}` };
    }
    if (!response.ok) {
      const reason = response.status >= 500 ? "temporary" : "permanent";
      return { ok: false, reason, error: `Картинка по ссылке не скачалась (ответ ${response.status})` };
    }
    const pathname = new URL(imagePath).pathname;
    const filename = basename(pathname) || "image";
    const contentType = response.headers.get("content-type")?.split(";")[0] || typeFor(filename);
    let bytes: Uint8Array | null;
    try {
      bytes = await readUpTo(response, IMAGE_SIZE_LIMIT);
    } catch (error) {
      return { ok: false, reason: "temporary", error: `Не удалось скачать картинку: ${messageOf(error)}` };
    }
    if (!bytes) return { ok: false, reason: "permanent", error: `Картинка по ссылке больше ${IMAGE_SIZE_LIMIT / 1024 / 1024} МБ` };
    return { ok: true, image: { bytes, filename, contentType } };
  }

  try {
    const file = await readFile(imagePath);
    return { ok: true, image: { bytes: new Uint8Array(file), filename: basename(imagePath), contentType: typeFor(imagePath) } };
  } catch (error) {
    return { ok: false, reason: "permanent", error: `Не удалось прочитать картинку: ${messageOf(error)}` };
  }
}

/** Тело ответа, если оно не больше `limit` байт; больше — `null`, чтение обрывается на пределе. */
async function readUpTo(response: Response, limit: number): Promise<Uint8Array | null> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(read.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function typeFor(path: string): string {
  return IMAGE_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
