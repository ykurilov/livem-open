CREATE TABLE "app"."lead_magnet_bots" (
	"lead_magnet_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"channel" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."preview_conversations" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"lead_magnet_id" uuid NOT NULL,
	"current_stage_id" text,
	"stage_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"field_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" jsonb,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."lead_magnet_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_magnet_id" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	"source" text NOT NULL,
	"is_snapshot" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."lead_magnets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft" jsonb NOT NULL,
	"draft_version_id" uuid,
	"published_snapshot_id" uuid,
	"constructor_chat_id" text,
	"preview_chat_id" text,
	"pending_manual_edits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_magnets_constructor_chat_id_unique" UNIQUE("constructor_chat_id"),
	CONSTRAINT "lead_magnets_preview_chat_id_unique" UNIQUE("preview_chat_id")
);
--> statement-breakpoint
CREATE TABLE "app"."fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."lead_magnet_bots" ADD CONSTRAINT "lead_magnet_bots_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_magnet_bots" ADD CONSTRAINT "lead_magnet_bots_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "app"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."preview_conversations" ADD CONSTRAINT "preview_conversations_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_magnet_versions" ADD CONSTRAINT "lead_magnet_versions_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_magnet_bots_lead_magnet_channel" ON "app"."lead_magnet_bots" USING btree ("lead_magnet_id","channel");--> statement-breakpoint
CREATE INDEX "lead_magnet_bots_bot" ON "app"."lead_magnet_bots" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "lead_magnet_versions_lead_magnet" ON "app"."lead_magnet_versions" USING btree ("lead_magnet_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_name_lower" ON "app"."fields" USING btree (lower("name")) WHERE "app"."fields"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "app"."bots" ADD CONSTRAINT "bots_default_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("default_lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE no action ON UPDATE no action;