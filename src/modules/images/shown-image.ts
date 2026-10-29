import { uploadsDir } from "../mailings/images";
import { imageFilePath, isImageFileName } from "./image-file";

/** Картинка, которую показал консультант: для мессенджера (файл архива) и карточки человека (название). */
export interface ShownImage {
  id: string;
  title: string;
  /** Файл в папке загрузок. */
  fileName: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const ADDRESS_PREFIX = "/api/images/";

/** Картинки, показанные в сообщении через `show_image`, по порядку; отказы, незаконченные вызовы и чужие адреса пропускаются. */
export function shownImagesOf(parts: readonly unknown[]): ShownImage[] {
  return parts.flatMap((part) => {
    if (!isRecord(part) || part["type"] !== "tool-show_image" || part["state"] !== "output-available") return [];
    const image = isRecord(part["output"]) ? part["output"]["картинка"] : undefined;
    if (!isRecord(image) || typeof image["id"] !== "string" || typeof image["название"] !== "string") return [];
    const address = image["адрес"];
    if (typeof address !== "string" || !address.startsWith(ADDRESS_PREFIX)) return [];
    const fileName = address.slice(ADDRESS_PREFIX.length);
    return isImageFileName(fileName) ? [{ id: image["id"], title: image["название"], fileName }] : [];
  });
}

/**
 * Какую картинку человек получил с каждым ответом разговора (части ответов по порядку): только первую показанную в
 * ответе, и то если её не показывали раньше. Правило то же, что у роликов (`sentVideosOf`).
 */
export function sentImagesOf(replies: ReadonlyArray<readonly unknown[]>): Array<ShownImage | null> {
  const sent = new Set<string>();
  return replies.map((parts) => {
    const [first] = shownImagesOf(parts);
    if (!first || sent.has(first.id)) return null;
    sent.add(first.id);
    return first;
  });
}

/** Файл показанной картинки для отправки в мессенджер: папка загрузок общая у веба и работника. */
export function sentImagePath(image: ShownImage, dir = uploadsDir()): string | undefined {
  return imageFilePath(image.fileName, dir) ?? undefined;
}
