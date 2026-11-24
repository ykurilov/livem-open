CREATE TABLE "app"."preview_turn_snapshots" (
	"chat_id" text NOT NULL,
	"answer_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preview_turn_snapshots_chat_id_answer_id_pk" PRIMARY KEY("chat_id","answer_id")
);
--> statement-breakpoint
ALTER TABLE "app"."preview_turn_snapshots" ADD CONSTRAINT "preview_turn_snapshots_chat_id_preview_conversations_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "app"."preview_conversations"("chat_id") ON DELETE cascade ON UPDATE no action;