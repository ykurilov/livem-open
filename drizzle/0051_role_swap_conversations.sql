CREATE TABLE "app"."role_swap_conversations" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"lead_magnet_id" uuid NOT NULL,
	"client_brief" text,
	"client_card" text NOT NULL,
	"topic" text NOT NULL,
	"status" text NOT NULL,
	"finished_reason" text,
	"review" text,
	"answer_marks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"replaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."role_swap_conversations" ADD CONSTRAINT "role_swap_conversations_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "role_swap_conversations_current" ON "app"."role_swap_conversations" USING btree ("lead_magnet_id") WHERE "app"."role_swap_conversations"."replaced_at" is null;--> statement-breakpoint
CREATE INDEX "role_swap_conversations_lead_created" ON "app"."role_swap_conversations" USING btree ("lead_magnet_id","created_at");