import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { passages } from "../conversations/schema";
import { leadMagnets } from "../lead-magnets/schema";
import { appSchema } from "../platform/app-schema";

/**
 * Короткие ссылки `/i/<код>` на полные ссылки с подставленным текстом (`text_link`). Один текст и тип в одном
 * разговоре — один код: уникален разговор и отпечаток полной ссылки (сама она до ~8 КБ — индексу велика).
 */
export const textShortLinks = appSchema.table(
  "text_short_links",
  {
    code: text("code").primaryKey(),
    targetUrl: text("target_url").notNull(),
    /** sha256 полной ссылки: по нему повтор находит тот же код. */
    targetHash: text("target_hash").notNull(),
    /** Шаблон, которым собрана ссылка: перенаправление сверяет адрес с ним. */
    template: text("template").notNull(),
    chatId: text("chat_id").notNull(),
    leadMagnetId: uuid("lead_magnet_id").references(() => leadMagnets.id, { onDelete: "set null" }),
    passageId: uuid("passage_id").references(() => passages.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("text_short_links_chat_target").on(table.chatId, table.targetHash), index("text_short_links_lead_magnet").on(table.leadMagnetId)],
);
