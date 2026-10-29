<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Карта проекта

- `src/app` — страницы кабинета (Next.js) и маршруты API: вход, вебхуки мессенджеров, GetCourse, картинки.
- `src/modules` — модули предметной области, у каждого свой `index.ts`: лидмагниты, сценарии (`flows`), консультант,
  каналы Telegram/MAX/VK (`channels`), рассылки, люди и разговоры, учётные записи для входа (`accounts`), платформа (база, очередь, модели).
- `src/auth` — вход: по паролю (по умолчанию) или через единый вход OIDC (`AUTH_MODE=sso`).
- `src/worker` — работник: миграции при старте, очередь, касания и рассылки.
- `prompts` — инструкции моделей. `drizzle` — миграции базы (`pnpm db:generate` после правки схем `schema.ts`).
- `scripts` — консольные команды: `lead-magnet-cli.ts` (лидмагниты из консоли), `set-password.ts` (пароль входа).
- `evals` — проверка консультанта разговорами с моделью-собеседником (`pnpm eval`), оценка — по `evals/judge.md`.

## Проверки

- Юнит: `pnpm test:unit`. С базой: `docker compose -f docker-compose.dev.yml up -d`, затем `pnpm test:integration`.
- Браузерные: `pnpm test:e2e` (Playwright, своя база на порту 55439).
- Типы: `pnpm typecheck`.
