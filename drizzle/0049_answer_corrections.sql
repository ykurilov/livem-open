CREATE TABLE "app"."answer_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_magnet_id" uuid NOT NULL,
	"source" text NOT NULL,
	"agent_role" text NOT NULL,
	"chat_id" text NOT NULL,
	"original_message_id" text NOT NULL,
	"corrected_message_id" text NOT NULL,
	"answer_kind" text NOT NULL,
	"original_text" text NOT NULL,
	"corrected_text" text NOT NULL,
	"reason" text,
	"context" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"stage_id" text,
	"program_day" integer,
	"draft_version_id" uuid NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"resolved_version_id" uuid,
	"resolved_at" timestamp with time zone,
	"announced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."answer_corrections" ADD CONSTRAINT "answer_corrections_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_corrections_lead_status" ON "app"."answer_corrections" USING btree ("lead_magnet_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "answer_corrections_pending_answer" ON "app"."answer_corrections" USING btree ("original_message_id") WHERE "app"."answer_corrections"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "answer_corrections_chat" ON "app"."answer_corrections" USING btree ("chat_id");