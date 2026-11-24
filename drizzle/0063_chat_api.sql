CREATE TABLE "app"."chat_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_magnet_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"key_start" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "chat_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "app"."chat_api_sites" (
	"lead_magnet_id" uuid PRIMARY KEY NOT NULL,
	"sites" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."chat_api_visitors" (
	"lead_magnet_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"visitor_id" uuid NOT NULL,
	"token_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_api_visitors_lead_magnet_id_external_id_pk" PRIMARY KEY("lead_magnet_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "app"."chat_api_keys" ADD CONSTRAINT "chat_api_keys_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chat_api_sites" ADD CONSTRAINT "chat_api_sites_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chat_api_visitors" ADD CONSTRAINT "chat_api_visitors_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chat_api_visitors" ADD CONSTRAINT "chat_api_visitors_visitor_id_web_chat_visitors_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "app"."web_chat_visitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_api_keys_lead_magnet_idx" ON "app"."chat_api_keys" USING btree ("lead_magnet_id");