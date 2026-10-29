CREATE TABLE "app"."text_short_links" (
	"code" text PRIMARY KEY NOT NULL,
	"target_url" text NOT NULL,
	"target_hash" text NOT NULL,
	"template" text NOT NULL,
	"chat_id" text NOT NULL,
	"lead_magnet_id" uuid,
	"passage_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."text_short_links" ADD CONSTRAINT "text_short_links_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."text_short_links" ADD CONSTRAINT "text_short_links_passage_id_passages_id_fk" FOREIGN KEY ("passage_id") REFERENCES "app"."passages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "text_short_links_chat_target" ON "app"."text_short_links" USING btree ("chat_id","target_hash");--> statement-breakpoint
CREATE INDEX "text_short_links_lead_magnet" ON "app"."text_short_links" USING btree ("lead_magnet_id");