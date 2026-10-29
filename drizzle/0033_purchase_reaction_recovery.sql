ALTER TABLE "app"."passages" ADD COLUMN "payment_reminder_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "purchase_congratulation_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."product_orders" ADD COLUMN "reaction_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."product_orders" ADD COLUMN "reaction_revision" integer DEFAULT 0 NOT NULL;
