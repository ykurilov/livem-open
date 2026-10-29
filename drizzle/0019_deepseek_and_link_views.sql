-- DeepSeek 4.1 Flash теперь идёт у самого DeepSeek (запасной — OpenRouter), а не у Together.
-- Переводятся черновики, все версии и снимки, начатые чаты и запомненный выбор модели: модель та же, меняется только провайдер.
-- Другие модели и другие провайдеры не трогаются.
UPDATE "app"."lead_magnets" SET "draft" = jsonb_set("draft", '{providerId}', '"deepseek"')
WHERE "draft"->>'providerId' = 'together' AND "draft"->>'modelId' = 'deepseek-4.1-flash';--> statement-breakpoint
UPDATE "app"."lead_magnet_versions" SET "settings" = jsonb_set("settings", '{providerId}', '"deepseek"')
WHERE "settings"->>'providerId' = 'together' AND "settings"->>'modelId' = 'deepseek-4.1-flash';--> statement-breakpoint
-- Таблицы чатов создаёт хранилище SDK при первом открытии: в новой базе их ещё может не быть
DO $$
BEGIN
  IF to_regclass('agent_chat.chats') IS NOT NULL THEN
    UPDATE agent_chat.chats SET provider_id = 'deepseek' WHERE provider_id = 'together' AND model_id = 'deepseek-4.1-flash';
  END IF;
  IF to_regclass('agent_chat.user_model_choices') IS NOT NULL THEN
    UPDATE agent_chat.user_model_choices SET provider_id = 'deepseek' WHERE provider_id = 'together' AND model_id = 'deepseek-4.1-flash';
  END IF;
END $$;--> statement-breakpoint
-- Настройки получили переключатель «смотреть ссылки человека»: в старых черновиках и версиях он выключен
UPDATE "app"."lead_magnets" SET "draft" = "draft" || '{"viewsLinks": false}'::jsonb WHERE NOT ("draft" ? 'viewsLinks');--> statement-breakpoint
UPDATE "app"."lead_magnet_versions" SET "settings" = "settings" || '{"viewsLinks": false}'::jsonb WHERE NOT ("settings" ? 'viewsLinks');
