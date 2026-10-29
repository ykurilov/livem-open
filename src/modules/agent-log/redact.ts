const HIDDEN = "[скрыто]";
const MAX_STRING_LENGTH = 20_000;

/** Переменные окружения, чьи значения — секреты. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|DATABASE_URL|COOKIE/i;
/** Поля, значение которых скрывается целиком: `botToken`, `apiKey`, `X-Proxy-Token`… но не `inputTokens`. */
const SECRET_FIELD_NAME = /(token|api[-_]?key|secret|password|passwd|authorization|cookie)$/i;
/** Секреты по виду: токен бота Telegram, ключи `sk-…`. */
const SECRET_SHAPES = [/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, /\bsk-[A-Za-z0-9_-]{16,}/g];
const BEARER = /(Bearer\s+)[^\s"',;]+/gi;

/**
 * Чистильщик записей журнала: значения секретов окружения, поля с секретными именами и строки, похожие на ключи,
 * заменяются на «[скрыто]»; очень длинные строки обрезаются.
 */
export function createRedactor(env: Record<string, string | undefined>): (value: unknown) => unknown {
  const secretValues = Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && value.length >= 6)
    .map(([, value]) => value as string)
    // Длинные первыми: значение, содержащее другое, вычищается целиком
    .sort((a, b) => b.length - a.length);

  const redactString = (text: string): string => {
    let result = text;
    for (const secret of secretValues) result = result.split(secret).join(HIDDEN);
    for (const shape of SECRET_SHAPES) result = result.replace(shape, HIDDEN);
    result = result.replace(BEARER, `$1${HIDDEN}`);
    if (result.length > MAX_STRING_LENGTH) {
      result = `${result.slice(0, MAX_STRING_LENGTH)}… [обрезано ${result.length - MAX_STRING_LENGTH} знаков]`;
    }
    return result;
  };

  const redact = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return redactString(value);
    if (value === null || typeof value !== "object") return value;
    if (depth > 30) return "[слишком глубоко]";
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_FIELD_NAME.test(key) && item !== null && item !== undefined ? HIDDEN : redact(item, depth + 1);
    }
    return result;
  };

  return (value) => redact(value, 0);
}
