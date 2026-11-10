CREATE TABLE "app"."web_chat_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "web_chat_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "app"."web_chat_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"visitor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."web_chat_visitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_code" text,
	"push_subscription" jsonb,
	"last_seen_at" timestamp with time zone,
	"resume_code_hash" text,
	"resume_code_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."web_chat_tokens" ADD CONSTRAINT "web_chat_tokens_visitor_id_web_chat_visitors_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "app"."web_chat_visitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_chat_limits_window" ON "app"."web_chat_limits" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "web_chat_tokens_visitor" ON "app"."web_chat_tokens" USING btree ("visitor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_chat_visitors_resume_code_hash" ON "app"."web_chat_visitors" USING btree ("resume_code_hash");--> statement-breakpoint
CREATE INDEX "inbound_messages_bot_user_received" ON "app"."inbound_messages" USING btree ("bot_id","external_user_id","received_at");