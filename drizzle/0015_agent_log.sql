CREATE TABLE "app"."agent_log_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"turn_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."agent_log_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_magnet_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"agent" text NOT NULL,
	"source" text,
	"person_id" uuid,
	"person_label" text,
	"channel" text,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."agent_log_entries" ADD CONSTRAINT "agent_log_entries_turn_id_agent_log_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "app"."agent_log_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_log_turns" ADD CONSTRAINT "agent_log_turns_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_log_entries_turn" ON "app"."agent_log_entries" USING btree ("turn_id","id");--> statement-breakpoint
CREATE INDEX "agent_log_turns_lead_started" ON "app"."agent_log_turns" USING btree ("lead_magnet_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_log_turns_started" ON "app"."agent_log_turns" USING btree ("started_at");