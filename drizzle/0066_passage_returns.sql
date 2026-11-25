CREATE TABLE "app"."passage_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"passage_id" uuid NOT NULL,
	"lead_magnet_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."passage_returns" ADD CONSTRAINT "passage_returns_passage_id_passages_id_fk" FOREIGN KEY ("passage_id") REFERENCES "app"."passages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."passage_returns" ADD CONSTRAINT "passage_returns_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passage_returns_lead_magnet" ON "app"."passage_returns" USING btree ("lead_magnet_id","kind");