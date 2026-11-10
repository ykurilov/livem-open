/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Значок разработки слева внизу закрывал кнопку «Раскрыть меню» в боковой панели
  devIndicators: { position: "bottom-right" },
  // Корень сборки — этот проект, а не папка выше с чужим pnpm-workspace.yaml
  outputFileTracingRoot: import.meta.dirname,
  // Пакеты с серверной частью, которые Next не должен бандлить
  // Сценарии SDK читают свои миграции с диска (`drizzle/postgres` рядом с пакетом) — их тоже не бандлить
  serverExternalPackages: ["pg", "pg-boss", "@ykurilov/agent-chat-storage-postgres", "@ykurilov/agent-chat-flows"],
  // Картинка рассылки — до 10 МБ, плюс текст формы
  experimental: { serverActions: { bodySizeLimit: "11mb" }, proxyClientMaxBodySize: "11mb" },
  // Инструкции агентов читаются с диска во время работы
  // Миграции пакетов SDK лежат рядом с пакетом (`new URL("../drizzle", import.meta.url)`): Turbopack их сам не находит
  outputFileTracingIncludes: {
    "/api/constructor/[...path]": ["./prompts/**/*"],
    "/**": [
      "./node_modules/.pnpm/@ykurilov+agent-chat-storage-postgres@*/node_modules/@ykurilov/agent-chat-storage-postgres/drizzle/**/*",
      "./node_modules/.pnpm/@ykurilov+agent-chat-flows@*/node_modules/@ykurilov/agent-chat-flows/drizzle/**/*",
    ],
  },
  // Сквозные проверки: `next dev` не выгружает заранее собранные страницы, иначе их пересборка посреди теста длится секунды
  ...(process.env.E2E_KEEP_DEV_PAGES ? { onDemandEntries: { maxInactiveAge: 60 * 60 * 1000, pagesBufferLength: 100 } } : {}),
};

export default nextConfig;
