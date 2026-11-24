CREATE TABLE "app"."constructor_chats" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"lead_magnet_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Прежний единственный чат конструктора становится первым в списке своего лидмагнита
INSERT INTO "app"."constructor_chats" ("chat_id", "lead_magnet_id", "created_at")
SELECT "constructor_chat_id", "id", "created_at" FROM "app"."lead_magnets" WHERE "constructor_chat_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."lead_magnets" DROP CONSTRAINT "lead_magnets_constructor_chat_id_unique";--> statement-breakpoint
ALTER TABLE "app"."constructor_chats" ADD CONSTRAINT "constructor_chats_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "constructor_chats_lead_magnet" ON "app"."constructor_chats" USING btree ("lead_magnet_id");--> statement-breakpoint
ALTER TABLE "app"."lead_magnets" DROP COLUMN "constructor_chat_id";