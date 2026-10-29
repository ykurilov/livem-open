ALTER TABLE "app"."preview_conversations" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "app"."preview_conversations" ADD COLUMN "person_message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."preview_conversations" ADD COLUMN "sale_answer" jsonb;--> statement-breakpoint
ALTER TABLE "app"."preview_conversations" ADD COLUMN "side_tasks" jsonb DEFAULT '{}'::jsonb NOT NULL;