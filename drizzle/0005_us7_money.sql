CREATE TABLE "app"."model_health" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_failure_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"passage_id" uuid,
	"cost_usd" numeric(12, 6) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."passages" ADD COLUMN "turn_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."model_usage" ADD CONSTRAINT "model_usage_passage_id_passages_id_fk" FOREIGN KEY ("passage_id") REFERENCES "app"."passages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_usage_created" ON "app"."model_usage" USING btree ("created_at");