import { sql } from "drizzle-orm";
import { boolean, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "../platform/app-schema";
import type { LeadMagnetSettings } from "./settings";

/** `agent` — правка консольной командой агента от имени эксперта (scripts/lead-magnet-cli.ts). */
export const VERSION_SOURCES = ["constructor", "manual", "rollback", "agent"] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];

/** Заметка «эксперт вручную изменил …» для конструктора. Уходит хвостом следующего хода и стирается. */
export interface ManualEditNote {
  id: string;
  text: string;
  at: string;
}

export const leadMagnets = appSchema.table("lead_magnets", {
  id: uuid("id").primaryKey().defaultRandom(),
  draft: jsonb("draft").$type<LeadMagnetSettings>().notNull(),
  draftVersionId: uuid("draft_version_id"),
  publishedSnapshotId: uuid("published_snapshot_id"),
  constructorChatId: text("constructor_chat_id").unique(),
  previewChatId: text("preview_chat_id").unique(),
  pendingManualEdits: jsonb("pending_manual_edits").$type<ManualEditNote[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Неизменные копии настроек: каждое сохранение черновика, откат и (позже) публикация. */
export const leadMagnetVersions = appSchema.table(
  "lead_magnet_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadMagnetId: uuid("lead_magnet_id")
      .notNull()
      .references(() => leadMagnets.id, { onDelete: "cascade" }),
    settings: jsonb("settings").$type<LeadMagnetSettings>().notNull(),
    source: text("source").$type<VersionSource>().notNull(),
    isSnapshot: boolean("is_snapshot").notNull().default(false),
    // Время записи, а не начала транзакции: по нему идут версии в «Истории»
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (table) => [index("lead_magnet_versions_lead_magnet").on(table.leadMagnetId, table.createdAt)],
);

/**
 * Ссылки, по которым человек приходит в лидмагнит. `label = null` — основная ссылка (одна на лидмагнит),
 * остальные — рекламные метки. Архивная ссылка распознаётся ради учёта, но не показывается.
 */
export const entryLinks = appSchema.table(
  "entry_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadMagnetId: uuid("lead_magnet_id")
      .notNull()
      .references(() => leadMagnets.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    label: text("label"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("entry_links_code").on(table.code),
    uniqueIndex("entry_links_main").on(table.leadMagnetId).where(sql`${table.label} is null`),
    // Действующая метка лидмагнита — одна на имя без учёта регистра; в архиве может лежать сколько угодно
    uniqueIndex("entry_links_active_label")
      .on(table.leadMagnetId, sql`lower(${table.label})`)
      .where(sql`${table.label} is not null and ${table.archivedAt} is null`),
  ],
);
