ALTER TABLE "app"."passages" ADD COLUMN "sale_reached_earlier" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Переведённые раньше: нода из истории этапов — «продажа» в версии, с которой позже был перевод (строка «Лога»).
-- Строки «Лога» нет — отметки нет.
UPDATE "app"."passages" AS "p" SET "sale_reached_earlier" = true
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements("p"."stage_history") AS "entry"
  JOIN "app"."agent_log_turns" AS "t" ON "t"."lead_magnet_id" = "p"."lead_magnet_id"
  JOIN "app"."agent_log_entries" AS "e"
    ON "e"."turn_id" = "t"."id" AND "e"."kind" = 'migration' AND "e"."at" > ("entry"->>'at')::timestamptz
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof("e"."data"->'moves') = 'array' THEN "e"."data"->'moves' ELSE '[]'::jsonb END
  ) AS "move"
  JOIN "app"."lead_magnet_versions" AS "v" ON "v"."id"::text = "move"->>'fromVersionId' AND "v"."id" <> "p"."snapshot_id"
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof("v"."settings"->'flow'->'states') = 'array' THEN "v"."settings"->'flow'->'states' ELSE '[]'::jsonb END
  ) AS "state"
  WHERE "state"->>'id' = "entry"->>'stageId' AND "state"->'tags' ? 'продажа'
);
