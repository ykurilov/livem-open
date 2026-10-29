import { createHash } from "node:crypto";
import { TEST_ADMIN_DATABASE_URL } from "../integration/test-database-url";

// Своя база и свой порт у каждой копии репозитория: соседние worktree не мешают друг другу
const checkoutTag = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 6);

export const E2E_PORT = 3100 + (parseInt(checkoutTag, 16) % 800);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_DATABASE_NAME = `livem_e2e_${checkoutTag}`;
export const E2E_EMAIL = "e2e@example.com";
/** Строка в выводе сервера: страницы собраны, можно начинать. */
export const E2E_READY_LINE = "E2E: сервер прогрет";
/** Не настоящий секрет: им запечатана только cookie тестового входа. */
export const E2E_COOKIE_SECRET = "e2e-cookie-secret-not-for-production-use";
/** Не настоящий ключ: им шифруются токены подделки мессенджера в тестовой базе. */
const E2E_BOT_TOKEN_KEY = Buffer.alloc(32, 5).toString("base64");

export function e2eDatabaseUrl(): string {
  const url = new URL(TEST_ADMIN_DATABASE_URL);
  url.pathname = `/${E2E_DATABASE_NAME}`;
  return url.toString();
}

/** Окружение сервера и работника для сквозных проверок: тестовая база, вход по паролю или готовой cookie, подставные модель и мессенджер. */
export function e2eServerEnv(): Record<string, string> {
  return {
    DATABASE_URL: e2eDatabaseUrl(),
    // Вход по паролю, как у новой установки; остальные тесты входят готовой cookie сессии
    AUTH_MODE: "password",
    AUTH_COOKIE_SECRET: E2E_COOKIE_SECRET,
    ALLOWED_EMAILS: E2E_EMAIL,
    PUBLIC_BASE_URL: E2E_BASE_URL,
    STUB_MODEL: "scripted",
    STUB_CHANNEL: "fake",
    BOT_TOKEN_KEY: E2E_BOT_TOKEN_KEY,
  };
}

/**
 * Заголовок для запросов тестов к серверу в обход браузера (вебхуки мессенджера). Playwright держит соединение открытым
 * и берёт его снова; сервер закрывает простаивающее через 5 секунд. Если тест ждал дольше и запрос ушёл в момент
 * закрытия, он падает `read ECONNRESET` без повтора. Каждый запрос со своим соединением такой гонки не знает.
 */
export const FRESH_CONNECTION = { connection: "close" } as const;
