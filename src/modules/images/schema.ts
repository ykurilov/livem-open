import { integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "../platform/app-schema";

/** Архив картинок эксперта (скриншоты «куда нажать»): из него консультант показывает картинки, разрешённые лидмагниту. */
export const images = appSchema.table("images", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  /** Когда показывать и что на картинке: по нему консультант её находит. */
  description: text("description").notNull(),
  /** Имя файла в папке загрузок (`image-<uuid>.<расширение>`). Файл не удаляется: показанные картинки живут в истории. */
  fileName: text("file_name").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  /** Удалённую картинку консультант больше не находит; показанные остаются в истории. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
