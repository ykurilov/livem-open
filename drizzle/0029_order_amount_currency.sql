ALTER TABLE "app"."product_orders" ADD COLUMN "amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "app"."product_orders" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "app"."product_orders" ADD COLUMN "refunded_at" timestamp with time zone;