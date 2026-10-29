CREATE TABLE "app"."alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"period" text DEFAULT '' NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mailing_id" uuid,
	"text" text NOT NULL,
	"image_path" text,
	"buttons" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"external_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"reminder_chain" jsonb NOT NULL,
	"daily_limit_usd" numeric(12, 6) DEFAULT '1.00' NOT NULL,
	"monthly_budget_usd" numeric(12, 6),
	"budget_acknowledged_at" timestamp with time zone,
	"max_message_chars" integer DEFAULT 2000 NOT NULL,
	"privacy_policy_url" text,
	"alert_chat_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_kind_period" ON "app"."alerts" USING btree ("kind","period");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_messages_idempotency_key" ON "app"."outbound_messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_messages_person" ON "app"."outbound_messages" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "outbound_messages_mailing" ON "app"."outbound_messages" USING btree ("mailing_id");