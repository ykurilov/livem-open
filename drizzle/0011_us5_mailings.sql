CREATE TABLE "app"."mailing_recipients" (
	"mailing_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"outbound_message_id" uuid,
	"error" text,
	CONSTRAINT "mailing_recipients_mailing_id_person_id_pk" PRIMARY KEY("mailing_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "app"."mailings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text NOT NULL,
	"image_path" text,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scheduled_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"test_person_id" uuid,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."mailing_recipients" ADD CONSTRAINT "mailing_recipients_mailing_id_mailings_id_fk" FOREIGN KEY ("mailing_id") REFERENCES "app"."mailings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailing_recipients_waiting" ON "app"."mailing_recipients" USING btree ("mailing_id","bot_id") WHERE "app"."mailing_recipients"."outbound_message_id" is null and "app"."mailing_recipients"."error" is null;