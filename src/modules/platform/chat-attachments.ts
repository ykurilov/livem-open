import { resolve } from "node:path";
import { createAttachments, createDiskAttachmentStorage, type Attachments } from "@ykurilov/agent-chat-attachments";
import { optionalEnv } from "./env";

/** Картинки, которые принимают чаты приложения: снимки экрана и фото. PDF и текстовые файлы — нет. */
export const CHAT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/**
 * Папка картинок чатов процесса. Хранилище SDK на диске рассчитано на один процесс, поэтому у сайта и у работника
 * очереди папки свои: сайт принимает картинки конструктора и проверки, работник — фото из мессенджеров.
 */
export function chatAttachmentsDir(process: "web" | "worker", env: Record<string, string | undefined> = globalThis.process.env): string {
  const root = optionalEnv("ATTACHMENTS_DIR", env) ?? (env.NODE_ENV === "production" ? "/app/data/attachments" : resolve("data/attachments"));
  return resolve(root, process);
}

/**
 * Сколько хранится картинка, которая так и не ушла в сообщении. Сайт — сутки, как у SDK: человек прикрепляет и сразу
 * отправляет. Работник — неделя: фото из мессенджера ждёт в очереди ход, повторы после сбоя модели и паузу сотрудника,
 * а ссылка мессенджера на файл к тому времени уже не скачивается. Бессрочно нельзя: фото хода, который так и не
 * отправился, копились бы на диске.
 */
export const UNSENT_IMAGE_RETENTION_MS = { web: 24 * 60 * 60 * 1000, worker: 7 * 24 * 60 * 60 * 1000 } as const;

export function createChatImages(storage: Parameters<typeof createAttachments>[0]["storage"], unsentRetentionMs: number = UNSENT_IMAGE_RETENTION_MS.web): Attachments {
  return createAttachments({ storage, acceptedMediaTypes: CHAT_IMAGE_TYPES, unsentRetentionMs });
}

// Одно хранилище на папку и процесс: в `next dev` модули перезагружаются, поэтому лежит в globalThis
const shared = globalThis as typeof globalThis & { livemChatImages?: Map<string, Attachments> };

/** Картинки чатов этого процесса: одни на все чаты, которые он ведёт. */
export function getChatImages(process: "web" | "worker"): Attachments {
  const dir = chatAttachmentsDir(process);
  const all = (shared.livemChatImages ??= new Map());
  let images = all.get(dir);
  if (!images) all.set(dir, (images = createChatImages(createDiskAttachmentStorage({ directory: dir }), UNSENT_IMAGE_RETENTION_MS[process])));
  return images;
}
