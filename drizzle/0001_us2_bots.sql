CREATE TABLE "app"."bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"title" text NOT NULL,
	"external_id" text NOT NULL,
	"username" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"status_error" text,
	"check_failures" integer DEFAULT 0 NOT NULL,
	"no_code_mode" text DEFAULT 'nothing' NOT NULL,
	"default_lead_magnet_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."outbound_messages" ADD COLUMN "sent_parts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bots_channel_external_id" ON "app"."bots" USING btree ("channel","external_id");