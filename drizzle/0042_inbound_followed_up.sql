ALTER TABLE "app"."inbound_messages" ADD COLUMN "flow_ends" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."inbound_messages" ADD COLUMN "followed_up_at" timestamp with time zone;--> statement-breakpoint
-- Входящие, разобранные до этой версии, считаются доведёнными: подмётчик за них не берётся
UPDATE "app"."inbound_messages" SET "followed_up_at" = "processed_at" WHERE "processed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inbound_messages_not_followed_up" ON "app"."inbound_messages" USING btree ("processed_at") WHERE "app"."inbound_messages"."processed_at" is not null and "app"."inbound_messages"."followed_up_at" is null;