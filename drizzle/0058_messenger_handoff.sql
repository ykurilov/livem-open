CREATE TABLE "app"."messenger_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"passage_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"code" text NOT NULL,
	"offered_at" timestamp with time zone NOT NULL,
	"taken_at" timestamp with time zone,
	"taken_bot_id" uuid,
	"taken_inbound_id" uuid,
	"signaled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."preview_conversations" ADD COLUMN "messenger_offered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."preview_conversations" ADD COLUMN "messenger_channel" text;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "chat_owner_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."messenger_handoffs" ADD CONSTRAINT "messenger_handoffs_passage_id_passages_id_fk" FOREIGN KEY ("passage_id") REFERENCES "app"."passages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messenger_handoffs" ADD CONSTRAINT "messenger_handoffs_taken_bot_id_bots_id_fk" FOREIGN KEY ("taken_bot_id") REFERENCES "app"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_handoffs_passage" ON "app"."messenger_handoffs" USING btree ("passage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_handoffs_code" ON "app"."messenger_handoffs" USING btree ("code");--> statement-breakpoint
CREATE INDEX "messenger_handoffs_visitor" ON "app"."messenger_handoffs" USING btree ("visitor_id");--> statement-breakpoint
CREATE INDEX "messenger_handoffs_person" ON "app"."messenger_handoffs" USING btree ("person_id");