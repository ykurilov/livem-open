CREATE TABLE "app"."videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"description" text NOT NULL,
	"duration_seconds" integer,
	"chapters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Настройки лидмагнита получили список разрешённых роликов: в старых черновиках и версиях он пустой
UPDATE "app"."lead_magnets" SET "draft" = "draft" || '{"videoIds": []}'::jsonb WHERE NOT ("draft" ? 'videoIds');--> statement-breakpoint
UPDATE "app"."lead_magnet_versions" SET "settings" = "settings" || '{"videoIds": []}'::jsonb WHERE NOT ("settings" ? 'videoIds');
