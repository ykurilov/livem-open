-- DeepSeek 4.1 Flash теперь идёт через Together (запасные — сам DeepSeek, потом OpenRouter): DeepSeek напрямую всё время «too busy».
-- Переводятся черновики, все версии и снимки, начатые чаты и запомненный выбор модели: модель та же, меняется только провайдер.
-- Другие модели и другие провайдеры не трогаются.
UPDATE "app"."lead_magnets" SET "draft" = jsonb_set("draft", '{providerId}', '"together"')
WHERE "draft"->>'providerId' = 'deepseek' AND "draft"->>'modelId' = 'deepseek-4.1-flash';--> statement-breakpoint
UPDATE "app"."lead_magnet_versions" SET "settings" = jsonb_set("settings", '{providerId}', '"together"')
WHERE "settings"->>'providerId' = 'deepseek' AND "settings"->>'modelId' = 'deepseek-4.1-flash';--> statement-breakpoint
-- Таблицы чатов создаёт хранилище SDK при первом открытии: в новой базе их ещё может не быть
DO $$
BEGIN
  IF to_regclass('agent_chat.chats') IS NOT NULL THEN
    UPDATE agent_chat.chats SET provider_id = 'together' WHERE provider_id = 'deepseek' AND model_id = 'deepseek-4.1-flash';
  END IF;
  IF to_regclass('agent_chat.user_model_choices') IS NOT NULL THEN
    UPDATE agent_chat.user_model_choices SET provider_id = 'together' WHERE provider_id = 'deepseek' AND model_id = 'deepseek-4.1-flash';
  END IF;
END $$;
