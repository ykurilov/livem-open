import type { Attachments } from "@ykurilov/agent-chat-attachments";
import { eq } from "drizzle-orm";
import { findBotWithCredentials, type ChannelAdapters } from "../channels";
import type { TokenCipher } from "../platform/crypto";
import type { Database } from "../platform/db";
import { inboundMessages } from "./schema";

export interface ClientImagesDependencies {
  db: Database;
  adapters: ChannelAdapters;
  cipher: TokenCipher;
  /** Картинки чатов работника (`getChatImages("worker")`); нет — фото не скачиваются. */
  chatImages?: Attachments;
}

/** Фото клиента в сообщении для консультанта: часть `file` сообщения SDK. */
export interface ClientImage {
  attachmentId: string;
  mediaType: string;
  filename: string;
}

type InboundRow = typeof inboundMessages.$inferSelect;

/**
 * Фото клиента хода — во вложения чата: адаптер его бота скачивает байты по ссылке, SDK кладёт их к чату (`ingestFile`).
 * Номер вложения записывается во входящее: повтор хода берёт его, не скачивая снова. Сбой не роняет ход: у такого
 * сообщения номера нет, консультант получает прежнюю пометку о вложении.
 * Возвращает сообщения хода с номерами вложений и картинки по id входящего.
 */
export async function attachClientImages(
  deps: ClientImagesDependencies,
  input: { ownerId: string; chatId: string; messages: InboundRow[] },
): Promise<{ messages: InboundRow[]; images: Map<string, ClientImage> }> {
  const images = new Map<string, ClientImage>();
  const chatImages = deps.chatImages;
  if (!chatImages) return { messages: input.messages, images };

  const messages: InboundRow[] = [];
  for (const message of input.messages) {
    if (!message.imageRef) {
      messages.push(message);
      continue;
    }
    const image = (await storedImage(chatImages, message)) ?? (await downloadedImage(deps, chatImages, input, message));
    const imageAttachmentId = image?.attachmentId ?? null;
    if (imageAttachmentId !== message.imageAttachmentId)
      await deps.db.update(inboundMessages).set({ imageAttachmentId }).where(eq(inboundMessages.id, message.id));
    if (image) images.set(message.id, image);
    messages.push({ ...message, imageAttachmentId });
  }
  return { messages, images };
}

/** Фото, уже положенное прошлым ходом. Хранилище могло его убрать (неотправленное, через сутки) — тогда `null`. */
async function storedImage(chatImages: Attachments, message: InboundRow): Promise<ClientImage | null> {
  if (!message.imageAttachmentId) return null;
  const stored = await chatImages.storage.get(message.imageAttachmentId);
  return stored ? { attachmentId: stored.id, mediaType: stored.mediaType, filename: stored.name } : null;
}

async function downloadedImage(
  deps: ClientImagesDependencies,
  chatImages: Attachments,
  input: { ownerId: string; chatId: string },
  message: InboundRow,
): Promise<ClientImage | null> {
  const found = await findBotWithCredentials(deps.db, deps.cipher, message.botId);
  const adapter = found && deps.adapters[found.bot.channel];
  if (!found || !adapter?.downloadImage) return null;
  try {
    const loaded = await adapter.downloadImage(found.credentials, message.imageRef!);
    if (!loaded.ok) {
      console.warn(`Фото клиента ${message.id} не скачалось: ${loaded.error}`);
      return null;
    }
    const ingested = await chatImages.ingestFile({ userId: input.ownerId, chatId: input.chatId, bytes: loaded.image.bytes, name: loaded.image.filename });
    if (!ingested.ok) {
      console.warn(`Фото клиента ${message.id} не принято во вложения: ${ingested.reason}`);
      return null;
    }
    return { attachmentId: ingested.attachment.id, mediaType: ingested.attachment.mediaType, filename: ingested.attachment.name };
  } catch (error) {
    console.warn(`Фото клиента ${message.id} не скачалось:`, error instanceof Error ? error.message : error);
    return null;
  }
}
