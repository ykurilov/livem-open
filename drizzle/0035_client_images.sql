UPDATE "app"."lead_magnets" SET "draft" = "draft" || '{"clientImages": false}'::jsonb WHERE NOT ("draft" ? 'clientImages');--> statement-breakpoint
UPDATE "app"."lead_magnet_versions" SET "settings" = "settings" || '{"clientImages": false}'::jsonb WHERE NOT ("settings" ? 'clientImages');
