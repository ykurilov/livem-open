ALTER TABLE "app"."bots" ADD COLUMN "failure_kind" text;--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD COLUMN "repeat_last_message" boolean DEFAULT false NOT NULL;