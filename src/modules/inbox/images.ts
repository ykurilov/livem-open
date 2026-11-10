import { stat, readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { createDiskAttachmentStorage, type AttachmentStorage } from "@ykurilov/agent-chat-attachments";
import { and, eq } from "drizzle-orm";
import { createChannelAdapters, findBotWithCredentials, outboundMessages, type ChannelAdapters } from "../channels";
import { inboundMessages } from "../conversations/schema";
import { IMAGE_CONTENT_TYPES, readImageFile } from "../images";
import { uploadsDir } from "../mailings/images";
import { chatAttachmentsDir } from "../platform/chat-attachments";
import { createTokenCipher, type TokenCipher } from "../platform/crypto";
import type { DatabaseExecutor } from "../platform/db";
import { optionalEnv } from "../platform/env";
import { isUuid } from "../platform/uuid";

/** Картинка в переписке: `url` — адрес показа в кабинете; `null` — картинка была, но её файла больше нет. */
export interface InboxImage {
  url: string | null;
}

/** Откуда «Входящие» берут картинки переписки. */
export interface InboxImageFiles {
  /** Вложения чатов работника: там лежат фото клиента, которые уже видел консультант. Только чтение. */
  clientImages: Pick<AttachmentStorage, "get" | "readBytes">;
  /** Папка загрузок: картинки архива и рассылок, которые бот отправил человеку. */
  uploadsDir: string;
  /** Фото, которое консультант не скачивал (разговор уже у эксперта), докачивается из мессенджера по ссылке. */
  messengers?: { adapters: ChannelAdapters; cipher: TokenCipher };
}

/**
 * Картинки переписки для веб-процесса. Папку вложений работника сайт только читает: хранилище SDK рассчитано на один
 * процесс, а чтение записи и байтов ничего в ней не меняет.
 */
export function inboxImageFilesFromEnv(): InboxImageFiles {
  const botTokenKey = optionalEnv("BOT_TOKEN_KEY");
  return {
    clientImages: createDiskAttachmentStorage({ directory: chatAttachmentsDir("worker") }),
    uploadsDir: uploadsDir(),
    ...(botTokenKey && { messengers: { adapters: createChannelAdapters(), cipher: createTokenCipher(botTokenKey) } }),
  };
}

export const inboxImageUrl = (direction: "in" | "out", messageId: string) => `/api/inbox/images/${direction}/${messageId}`;

const CONTENT_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
// Так называют файлы архив картинок (`imageFileName`) и рассылки (`saveMailingImage`)
const SENT_IMAGE_NAME = /^(image|mailing)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

/** Файл картинки исходящего, если он лежит прямо в папке загрузок; ссылка, другой путь или чужое имя — `null`. */
function sentImageFile(imagePath: string, dir: string): string | null {
  const path = resolve(imagePath);
  return dirname(path) === resolve(dir) && SENT_IMAGE_NAME.test(basename(path)) ? path : null;
}

const fileExists = (path: string) => stat(path).then((found) => found.isFile(), () => false);

type InboundImageRow = { id: string; attachmentKind: string | null; imageRef: string | null; imageAttachmentId: string | null };

/** Фото клиента во входящем: лежит во вложениях или его можно скачать по ссылке мессенджера. Не фото — `null`. */
export async function inboundImage(files: InboxImageFiles, row: InboundImageRow): Promise<InboxImage | null> {
  if (row.attachmentKind !== "image") return null;
  const stored = row.imageAttachmentId ? await files.clientImages.get(row.imageAttachmentId) : undefined;
  return { url: stored || (row.imageRef && files.messengers) ? inboxImageUrl("in", row.id) : null };
}

/** Картинка, которую бот отправил с исходящим. Без картинки — `null`, файл удалён — `url: null`. */
export async function outboundImage(files: InboxImageFiles, row: { id: string; imagePath: string | null }): Promise<InboxImage | null> {
  if (!row.imagePath) return null;
  const path = sentImageFile(row.imagePath, files.uploadsDir);
  return { url: path && (await fileExists(path)) ? inboxImageUrl("out", row.id) : null };
}

const NOT_FOUND = () => new Response("Not found", { status: 404 });

const imageBytesResponse = (bytes: Uint8Array, contentType: string) =>
  new Response(new Uint8Array(bytes), { headers: { "content-type": contentType, "cache-control": "private, max-age=86400" } });

/**
 * Картинка переписки по id сообщения: путь к файлу берётся из базы, а не из адреса. Нет сообщения, картинки
 * или файла, файл не в папке загрузок — 404.
 */
export async function inboxImageResponse(
  db: DatabaseExecutor,
  files: InboxImageFiles,
  direction: string,
  messageId: string,
): Promise<Response> {
  if (!isUuid(messageId)) return NOT_FOUND();
  if (direction === "out") {
    const [row] = await db.select({ imagePath: outboundMessages.imagePath }).from(outboundMessages).where(eq(outboundMessages.id, messageId));
    const path = row?.imagePath ? sentImageFile(row.imagePath, files.uploadsDir) : null;
    const bytes = path ? await readFile(path).catch(() => null) : null;
    return bytes ? imageBytesResponse(bytes, CONTENT_TYPES[extname(path!)]!) : NOT_FOUND();
  }
  if (direction !== "in") return NOT_FOUND();

  const [row] = await db
    .select({ botId: inboundMessages.botId, imageRef: inboundMessages.imageRef, imageAttachmentId: inboundMessages.imageAttachmentId })
    .from(inboundMessages)
    .where(and(eq(inboundMessages.id, messageId), eq(inboundMessages.attachmentKind, "image")));
  if (!row) return NOT_FOUND();
  if (row.imageAttachmentId) {
    const [stored, bytes] = await Promise.all([files.clientImages.get(row.imageAttachmentId), files.clientImages.readBytes(row.imageAttachmentId)]);
    if (stored && bytes) return imageBytesResponse(bytes, stored.mediaType);
  }
  return row.imageRef ? downloadedImageResponse(db, files, row.botId, row.imageRef) : NOT_FOUND();
}

async function downloadedImageResponse(db: DatabaseExecutor, files: InboxImageFiles, botId: string, imageRef: string): Promise<Response> {
  if (!files.messengers) return NOT_FOUND();
  const found = await findBotWithCredentials(db, files.messengers.cipher, botId);
  const adapter = found && files.messengers.adapters[found.bot.channel];
  if (!found || !adapter?.downloadImage) return NOT_FOUND();
  const loaded = await adapter.downloadImage(found.credentials, imageRef);
  // Telegram отдаёт фото как `application/octet-stream`: вид — по байтам, и не картинку не отдаём вовсе
  const kind = loaded.ok ? readImageFile(loaded.image.bytes) : null;
  return loaded.ok && kind ? imageBytesResponse(loaded.image.bytes, IMAGE_CONTENT_TYPES[kind.extension]) : NOT_FOUND();
}
