ALTER TABLE "app"."inbound_messages" ADD COLUMN "contact_source" text;--> statement-breakpoint
ALTER TABLE "app"."people" ADD COLUMN "source" text;