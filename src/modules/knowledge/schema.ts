import { integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "../platform/app-schema";

/** Текстовые базы знаний эксперта: прикреплённые к лидмагниту попадают в инструкцию его консультанта. */
export const knowledgeBases = appSchema.table("knowledge_bases", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  /** Имя загруженного файла — как у эксперта на компьютере: по нему он узнаёт, что загружено. */
  fileName: text("file_name").notNull(),
  /** Текст файла, уже прочитанный и приведённый к одному виду переводов строк. */
  content: text("content").notNull(),
  charCount: integer("char_count").notNull(),
  byteSize: integer("byte_size").notNull(),
  /** Меняется при переименовании и замене файла: по нему служба консультанта знает, что инструкция устарела. */
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Удалённую базу консультант больше не получает. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Файлы из чата конструктора, ставшие базами знаний. По номеру вложения модель на каждом ходе видит в истории одну и ту
 * же пометку о судьбе файла (кэш модели не сбивается), а повторная отправка того же файла базу не дублирует.
 */
export const knowledgeChatFiles = appSchema.table("knowledge_chat_files", {
  attachmentId: uuid("attachment_id").primaryKey(),
  /** База из файла; нет — файл базой не стал (причина в пометке). */
  knowledgeBaseId: uuid("knowledge_base_id").references(() => knowledgeBases.id),
  /** Что модель видит в истории вместо текста файла. */
  note: text("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
