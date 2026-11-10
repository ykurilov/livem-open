ALTER TABLE "app"."outbound_messages" ADD COLUMN "outcome_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "payment_reminder_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "outbound_messages_outcome_pending" ON "app"."outbound_messages" USING btree ("next_attempt_at") WHERE "app"."outbound_messages"."outcome_pending";--> statement-breakpoint
CREATE INDEX "passages_purchase_uncongratulated" ON "app"."passages" USING btree ("purchased_at") WHERE "app"."passages"."purchase_congratulated_at" is null;--> statement-breakpoint
CREATE INDEX "passages_payment_reminder_due" ON "app"."passages" USING btree ("payment_reminder_due_at") WHERE "app"."passages"."payment_reminder_sent_at" is null;