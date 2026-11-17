-- Заготовки эксперта: вместо «дословно» да/нет — режим из трёх (verbatim, own_words, formula). Третий, формула, — новый.
-- Переводятся черновики, все версии и снимки; заготовки уже с режимом и настройки без заготовок не трогаются.
UPDATE "app"."lead_magnets" SET "draft" = jsonb_set("draft", '{salesCards}', (
  SELECT jsonb_agg(CASE WHEN card ? 'mode' OR NOT card ? 'verbatim' THEN card
    ELSE (card - 'verbatim') || jsonb_build_object('mode', CASE WHEN card->>'verbatim' = 'true' THEN 'verbatim' ELSE 'own_words' END) END ORDER BY ord)
  FROM jsonb_array_elements("draft"->'salesCards') WITH ORDINALITY AS cards(card, ord)
))
WHERE jsonb_typeof("draft"->'salesCards') = 'array' AND jsonb_array_length("draft"->'salesCards') > 0
  AND EXISTS (SELECT 1 FROM jsonb_array_elements("draft"->'salesCards') AS cards(card) WHERE card ? 'verbatim');--> statement-breakpoint
UPDATE "app"."lead_magnet_versions" SET "settings" = jsonb_set("settings", '{salesCards}', (
  SELECT jsonb_agg(CASE WHEN card ? 'mode' OR NOT card ? 'verbatim' THEN card
    ELSE (card - 'verbatim') || jsonb_build_object('mode', CASE WHEN card->>'verbatim' = 'true' THEN 'verbatim' ELSE 'own_words' END) END ORDER BY ord)
  FROM jsonb_array_elements("settings"->'salesCards') WITH ORDINALITY AS cards(card, ord)
))
WHERE jsonb_typeof("settings"->'salesCards') = 'array' AND jsonb_array_length("settings"->'salesCards') > 0
  AND EXISTS (SELECT 1 FROM jsonb_array_elements("settings"->'salesCards') AS cards(card) WHERE card ? 'verbatim');
