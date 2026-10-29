import { integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "../platform/app-schema";

export interface VideoChapter {
  title: string;
  startSeconds: number;
}

/** Архив роликов эксперта: из него консультант присылает видео, разрешённые лидмагниту. */
export const videos = appSchema.table("videos", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  /** Ссылка YouTube или Kinescope — как её вставил эксперт. */
  url: text("url").notNull(),
  description: text("description").notNull(),
  durationSeconds: integer("duration_seconds"),
  chapters: jsonb("chapters").$type<VideoChapter[]>().notNull().default([]),
  /** Удалённый ролик консультант больше не находит; присланные карточки живут на данных сообщения. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
