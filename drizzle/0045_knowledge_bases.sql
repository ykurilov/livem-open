CREATE TABLE "app"."knowledge_bases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"file_name" text NOT NULL,
	"content" text NOT NULL,
	"char_count" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
UPDATE "app"."lead_magnets" SET "draft" = "draft" || '{"knowledgeIds": []}'::jsonb WHERE NOT ("draft" ? 'knowledgeIds');--> statement-breakpoint
UPDATE "app"."lead_magnet_versions" SET "settings" = "settings" || '{"knowledgeIds": []}'::jsonb WHERE NOT ("settings" ? 'knowledgeIds');
