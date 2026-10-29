CREATE TABLE "app"."inbox_threads" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"unanswered_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_reply_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."inbox_threads" ADD CONSTRAINT "inbox_threads_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "app"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_threads_unanswered" ON "app"."inbox_threads" USING btree ("last_message_at") WHERE "app"."inbox_threads"."unanswered_count" > 0;--> statement-breakpoint
-- Счётчик «Входящих» растёт на каждое входящее с route = inbox, откуда бы оно ни пришло: роутер, упавший ход, режим «ничего»
CREATE FUNCTION "app"."count_inbox_message"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.route = 'inbox' AND NEW.person_id IS NOT NULL
		AND (TG_OP = 'INSERT' OR OLD.route IS DISTINCT FROM 'inbox' OR OLD.person_id IS DISTINCT FROM NEW.person_id) THEN
		INSERT INTO "app"."inbox_threads" AS thread ("person_id", "unanswered_count", "last_message_at")
		VALUES (NEW.person_id, 1, NEW.received_at)
		ON CONFLICT ("person_id") DO UPDATE SET
			"unanswered_count" = thread."unanswered_count" + 1,
			"last_message_at" = greatest(thread."last_message_at", EXCLUDED."last_message_at");
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inbound_messages_count_inbox" AFTER INSERT OR UPDATE OF "route", "person_id" ON "app"."inbound_messages"
	FOR EACH ROW EXECUTE FUNCTION "app"."count_inbox_message"();
--> statement-breakpoint
-- Входящие, пришедшие до этой миграции
INSERT INTO "app"."inbox_threads" ("person_id", "unanswered_count", "last_message_at")
SELECT "person_id", count(*), max("received_at") FROM "app"."inbound_messages"
WHERE "route" = 'inbox' AND "person_id" IS NOT NULL
GROUP BY "person_id";
