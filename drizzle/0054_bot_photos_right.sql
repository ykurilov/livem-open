ALTER TABLE "app"."bots" ADD COLUMN "can_send_photos" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."outbound_messages" ADD COLUMN "image_not_sent" text;