CREATE TABLE "app"."product_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_order_id" text NOT NULL,
	"order_number" text,
	"status" text NOT NULL,
	"cost_rub" numeric(12, 2),
	"email" text,
	"external_user_id" text,
	"offer_title" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"passage_id" uuid,
	"matched_by" text,
	"paid_at" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "tracking_code" text;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "payment_email" text;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "payment_promised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "payment_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "purchased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "purchase_congratulated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."product_orders" ADD CONSTRAINT "product_orders_passage_id_passages_id_fk" FOREIGN KEY ("passage_id") REFERENCES "app"."passages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_orders_source_order" ON "app"."product_orders" USING btree ("source","external_order_id");--> statement-breakpoint
CREATE INDEX "product_orders_passage" ON "app"."product_orders" USING btree ("passage_id");--> statement-breakpoint
CREATE INDEX "product_orders_email" ON "app"."product_orders" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "passages_tracking_code" ON "app"."passages" USING btree ("tracking_code");--> statement-breakpoint
CREATE INDEX "passages_payment_email" ON "app"."passages" USING btree ("payment_email");