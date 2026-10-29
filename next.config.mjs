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
  outputFileTracingIncludes: { "/api/constructor/[...path]": ["./prompts/**/*"] },
  // Сквозные проверки: `next dev` не выгружает заранее собранные страницы, иначе их пересборка посреди теста длится секунды
  ...(process.env.E2E_KEEP_DEV_PAGES ? { onDemandEntries: { maxInactiveAge: 60 * 60 * 1000, pagesBufferLength: 100 } } : {}),
  // Модуль SSO написан в ESM со ссылками на `./x.js`, а файлы лежат как `.ts`
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
