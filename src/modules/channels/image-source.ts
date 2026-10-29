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
    return { ok: true, image: { bytes: new Uint8Array(await response.arrayBuffer()), filename, contentType } };
  }

  try {
    const file = await readFile(imagePath);
    return { ok: true, image: { bytes: new Uint8Array(file), filename: basename(imagePath), contentType: typeFor(imagePath) } };
  } catch (error) {
    return { ok: false, reason: "permanent", error: `Не удалось прочитать картинку: ${messageOf(error)}` };
  }
}

function typeFor(path: string): string {
  return IMAGE_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
