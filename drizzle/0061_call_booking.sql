CREATE TABLE "app"."call_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"person_id" uuid,
	"test_chat_id" text,
	"passage_id" uuid,
	"lead_magnet_id" uuid,
	"meeting_link" text,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"rescheduled_to_id" uuid,
	"reminder_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."call_calendar" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"time_zone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"call_minutes" integer DEFAULT 30 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."call_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"bot_id" uuid NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."call_notify_bots" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"connect_code" text,
	"chat_id" text,
	"connected_at" timestamp with time zone,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."call_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"weekly" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."call_bookings" ADD CONSTRAINT "call_bookings_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."call_notices" ADD CONSTRAINT "call_notices_booking_id_call_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "app"."call_bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."call_notices" ADD CONSTRAINT "call_notices_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "app"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."call_notify_bots" ADD CONSTRAINT "call_notify_bots_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "app"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_bookings_starts_at" ON "app"."call_bookings" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "call_bookings_person" ON "app"."call_bookings" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "call_bookings_test_chat" ON "app"."call_bookings" USING btree ("test_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "call_notices_booking_kind_bot" ON "app"."call_notices" USING btree ("booking_id","kind","bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "call_notify_bots_connect_code" ON "app"."call_notify_bots" USING btree ("connect_code");--> statement-breakpoint
ALTER TABLE "app"."call_bookings" ADD CONSTRAINT "call_bookings_no_overlap" EXCLUDE USING gist (tstzrange("starts_at", "ends_at", '[)') WITH &&) WHERE ("status" = 'booked' AND "test_chat_id" IS NULL);
