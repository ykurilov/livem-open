# Один образ для web и worker:
#   web:    node server.js
#   worker: node dist/worker.js
#   консольная команда агента: node dist/lead-magnet-cli.js
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Пакеты @ykurilov — из общего npm (с SDK 0.55): ключ не нужен
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Сборка загружает маршруты входа, а они проверяют настройки при загрузке. Заглушки — только на эту команду,
# в образ не попадают: при запуске настоящие значения приходят из .env
RUN AUTH_URL=https://auth.build.invalid AUTH_APP_URL=https://app.build.invalid \
    AUTH_COOKIE_SECRET=build-time-placeholder-not-a-real-secret \
    pnpm build && pnpm worker:build && pnpm cli:build

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/prompts ./prompts
# Проверка готовности работника для healthcheck
COPY --from=build /app/deploy/worker-ready.cjs ./deploy/worker-ready.cjs
# Работнику нужны пакеты, которые бандл не включает
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "server.js"]
