CREATE TABLE "app"."images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"file_name" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
UPDATE "app"."lead_magnets" SET "draft" = "draft" || '{"imageIds": []}'::jsonb WHERE NOT ("draft" ? 'imageIds');--> statement-breakpoint
UPDATE "app"."lead_magnet_versions" SET "settings" = "settings" || '{"imageIds": []}'::jsonb WHERE NOT ("settings" ? 'imageIds');
