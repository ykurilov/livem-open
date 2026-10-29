ALTER TABLE "app"."mailing_recipients" ADD COLUMN "bot_down_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."mailings" ADD COLUMN "batch_due_at" timestamp with time zone;