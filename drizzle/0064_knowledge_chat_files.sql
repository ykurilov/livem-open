CREATE TABLE "app"."knowledge_chat_files" (
	"attachment_id" uuid PRIMARY KEY NOT NULL,
	"knowledge_base_id" uuid,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."knowledge_chat_files" ADD CONSTRAINT "knowledge_chat_files_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "app"."knowledge_bases"("id") ON DELETE no action ON UPDATE no action;