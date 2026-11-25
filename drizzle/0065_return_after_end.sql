ALTER TABLE "app"."call_notices" ALTER COLUMN "booking_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."call_notices" ADD COLUMN "handover_key" text;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "returned_after_end_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "call_notices_handover_bot" ON "app"."call_notices" USING btree ("handover_key","bot_id");