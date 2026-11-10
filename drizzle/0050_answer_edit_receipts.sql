CREATE TABLE "app"."answer_edit_receipts" (
	"message_id" text PRIMARY KEY NOT NULL,
	"lead_magnet_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."answer_edit_receipts" ADD CONSTRAINT "answer_edit_receipts_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_edit_receipts_chat" ON "app"."answer_edit_receipts" USING btree ("chat_id");