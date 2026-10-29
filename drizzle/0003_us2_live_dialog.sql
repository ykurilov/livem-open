CREATE TABLE "app"."inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"external_user_id" text NOT NULL,
	"user_name" text,
	"text" text DEFAULT '' NOT NULL,
	"attachment_kind" text,
	"start_code" text,
	"button_payload" text,
	"callback_id" text,
	"person_id" uuid,
	"passage_id" uuid,
	"route" text,
	"started_passage" boolean DEFAULT false NOT NULL,
	"autoreply" boolean DEFAULT false NOT NULL,
	"turn_id" uuid,
	"answered_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."passages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"lead_magnet_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"entry_link_id" uuid,
	"chat_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_stage_id" text,
	"stage_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"person_message_count" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"last_person_message_at" timestamp with time zone,
	"reminder_step" integer DEFAULT 0 NOT NULL,
	"next_reminder_at" timestamp with time zone,
	"budget_paused_at" timestamp with time zone,
	"turn_lease_until" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."entry_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_magnet_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"bot_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"display_name" text,
	"field_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_autoreply_on" date,
	"last_manual_reply_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD CONSTRAINT "inbound_messages_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "app"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD CONSTRAINT "inbound_messages_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "app"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD CONSTRAINT "inbound_messages_passage_id_passages_id_fk" FOREIGN KEY ("passage_id") REFERENCES "app"."passages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD CONSTRAINT "passages_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "app"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD CONSTRAINT "passages_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD CONSTRAINT "passages_snapshot_id_lead_magnet_versions_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "app"."lead_magnet_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD CONSTRAINT "passages_entry_link_id_entry_links_id_fk" FOREIGN KEY ("entry_link_id") REFERENCES "app"."entry_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry_links" ADD CONSTRAINT "entry_links_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."people" ADD CONSTRAINT "people_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "app"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_messages_dedupe_key" ON "app"."inbound_messages" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "inbound_messages_passage" ON "app"."inbound_messages" USING btree ("passage_id");--> statement-breakpoint
CREATE INDEX "inbound_messages_person" ON "app"."inbound_messages" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passages_chat" ON "app"."passages" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passages_one_active_per_person" ON "app"."passages" USING btree ("person_id") WHERE "app"."passages"."status" = 'active';--> statement-breakpoint
CREATE INDEX "passages_lead_magnet" ON "app"."passages" USING btree ("lead_magnet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_links_code" ON "app"."entry_links" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_links_main" ON "app"."entry_links" USING btree ("lead_magnet_id") WHERE "app"."entry_links"."label" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "people_bot_external_user" ON "app"."people" USING btree ("bot_id","external_user_id");