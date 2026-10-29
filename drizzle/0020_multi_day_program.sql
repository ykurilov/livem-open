ALTER TABLE "app"."preview_conversations" ADD COLUMN "day_offset" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "program_start_date" date;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "day_message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "day_message_count_day" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "day_closed_notice_day" integer;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "outreach_sent_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "outreach_day" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "furthest_day" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "sale_answer" jsonb;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "side_tasks" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."people" ADD COLUMN "time_zone" text;--> statement-breakpoint
-- Многодневная программа: у старых лидмагнитов её нет (`program: null`), у этапов нет дня начала и отметки «Продажа».
-- Правки идут в черновиках, во всех версиях и снимках; уже заданные значения не затираются, повторный прогон безопасен.
UPDATE "app"."lead_magnets" SET "draft" = "draft" || '{"program": null}'::jsonb WHERE NOT ("draft" ? 'program');--> statement-breakpoint
UPDATE "app"."lead_magnet_versions" SET "settings" = "settings" || '{"program": null}'::jsonb WHERE NOT ("settings" ? 'program');--> statement-breakpoint
UPDATE "app"."lead_magnets" SET "draft" = jsonb_set("draft", '{stages}', (
  SELECT COALESCE(jsonb_agg('{"startDay": null, "isSale": false}'::jsonb || "stage"."value" ORDER BY "stage"."position"), '[]'::jsonb)
  FROM jsonb_array_elements("draft"->'stages') WITH ORDINALITY AS "stage"("value", "position"))
) WHERE jsonb_typeof("draft"->'stages') = 'array';--> statement-breakpoint
UPDATE "app"."lead_magnet_versions" SET "settings" = jsonb_set("settings", '{stages}', (
  SELECT COALESCE(jsonb_agg('{"startDay": null, "isSale": false}'::jsonb || "stage"."value" ORDER BY "stage"."position"), '[]'::jsonb)
  FROM jsonb_array_elements("settings"->'stages') WITH ORDINALITY AS "stage"("value", "position"))
) WHERE jsonb_typeof("settings"->'stages') = 'array';
