CREATE TABLE "app"."senler_added_subscribers" (
	"bot_id" uuid NOT NULL,
	"vk_user_id" text NOT NULL,
	"group_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "senler_added_subscribers_bot_id_vk_user_id_group_id_pk" PRIMARY KEY("bot_id","vk_user_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "app"."senler_connections" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"default_group_id" text,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."senler_lead_magnet_groups" (
	"lead_magnet_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"group_id" text NOT NULL,
	CONSTRAINT "senler_lead_magnet_groups_lead_magnet_id_bot_id_pk" PRIMARY KEY("lead_magnet_id","bot_id")
);
--> statement-breakpoint
ALTER TABLE "app"."senler_added_subscribers" ADD CONSTRAINT "senler_added_subscribers_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "app"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."senler_connections" ADD CONSTRAINT "senler_connections_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "app"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."senler_lead_magnet_groups" ADD CONSTRAINT "senler_lead_magnet_groups_lead_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("lead_magnet_id") REFERENCES "app"."lead_magnets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."senler_lead_magnet_groups" ADD CONSTRAINT "senler_lead_magnet_groups_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "app"."bots"("id") ON DELETE no action ON UPDATE no action;