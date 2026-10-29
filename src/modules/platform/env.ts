// Чтение переменных окружения с понятной ошибкой

export function requireEnv(name: string, env: Record<string, string | undefined> = process.env): string {
  const value = env[name];
  if (!value || value.trim() === "") throw new Error(`Не задана переменная окружения ${name}`);
  return value;
}

export function optionalEnv(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[name];
  return value && value.trim() !== "" ? value : undefined;
}

/** Адрес Bot API и пропуск прокси. Пропуск уходит только вместе с прокси-маршрутом, напрямую в Telegram — никогда. */
export function telegramApiFromEnv(env: Record<string, string | undefined> = process.env): {
  apiBaseUrl?: string;
  proxyToken?: string;
} {
  const apiBaseUrl = optionalEnv("TELEGRAM_API_BASE_URL", env);
  return apiBaseUrl ? { apiBaseUrl, proxyToken: optionalEnv("PROXY_TOKEN", env) } : {};
}
