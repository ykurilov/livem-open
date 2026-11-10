ALTER TABLE "app"."preview_conversations" ADD COLUMN "field_updated_at" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."people" ADD COLUMN "field_updated_at" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Когда записаны прежние значения, не хранилось. У человека берём его последнее сообщение (значения узнают из разговора),
-- нет его — появление в «Базе»; у тестового разговора — его начало.
UPDATE "app"."people" SET "field_updated_at" = (
  SELECT jsonb_object_agg("field"."key", to_char(COALESCE("people"."last_inbound_at", "people"."created_at") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM jsonb_object_keys("people"."field_values") AS "field"("key"))
WHERE "field_values" <> '{}'::jsonb;--> statement-breakpoint
UPDATE "app"."preview_conversations" SET "field_updated_at" = (
  SELECT jsonb_object_agg("field"."key", to_char("preview_conversations"."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM jsonb_object_keys("preview_conversations"."field_values") AS "field"("key"))
WHERE "field_values" <> '{}'::jsonb;
