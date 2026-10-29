// Конфиг модуля из env. Всё проверяем при загрузке — с понятными русскими
// ошибками, чтобы агент при интеграции сразу видел, чего не хватает.
// fetch и env внедряемы: в тестах модуль ходит в сервис in-process через мост.
export interface ModuleConfig {
  authUrl: string; // origin сервиса, без хвостового слэша
  appUrl: string; // origin приложения
  clientId: string;
  cookieSecret: string;
  fetch: typeof fetch;
}

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

function requireOrigin(value: string | undefined, name: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`Не задана переменная окружения ${name}`);
  }
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`${name} должна быть валидным URL, получено: ${value}`);
  }
}

// process.env читаем через globalThis, не импортируя node:process — core
// остаётся на чистых Web-стандартах, а в среде без process (браузер) просто
// сработает обычная проверка «переменная не задана».
type MaybeNodeGlobal = { process?: { env?: Record<string, string | undefined> } };

export function resolveEnv(options: LoadConfigOptions = {}): Record<string, string | undefined> {
  return options.env ?? (globalThis as MaybeNodeGlobal).process?.env ?? {};
}

// Секретом запечатана cookie сессии в обоих способах входа.
export function requireCookieSecret(env: Record<string, string | undefined>): string {
  const secret = env.AUTH_COOKIE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_COOKIE_SECRET должна содержать не менее 32 символов');
  }
  return secret;
}

export function loadModuleConfig(options: LoadConfigOptions = {}): ModuleConfig {
  const env = resolveEnv(options);
  const authUrl = requireOrigin(env.AUTH_URL, 'AUTH_URL');
  const appUrl = requireOrigin(env.AUTH_APP_URL, 'AUTH_APP_URL');
  const secret = requireCookieSecret(env);

  // client_id по умолчанию = hostname адреса приложения (та же конвенция, что у
  // краткой регистрации { baseUrl } в Admin API сервиса).
  const clientId =
    env.AUTH_CLIENT_ID && env.AUTH_CLIENT_ID.trim() !== ''
      ? env.AUTH_CLIENT_ID
      : new URL(appUrl).hostname;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch недоступен: передайте fetch в конфиг или используйте среду с глобальным fetch');
  }

  return { authUrl, appUrl, clientId, cookieSecret: secret, fetch: fetchImpl };
}
