ALTER TABLE "app"."bots" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD COLUMN "menu" boolean DEFAULT false NOT NULL;