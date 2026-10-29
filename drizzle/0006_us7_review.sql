ALTER TABLE "app"."passages" ADD COLUMN "daily_limit_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "handed_to_expert_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "handover_reason" text;