import { authMode } from './core/auth-mode.js';
import { requireCookieSecret, resolveEnv, type LoadConfigOptions } from './core/config.js';
import { unseal } from './core/cookie-seal.js';
import { isSessionAlive } from './password/password-session.js';
import { parseCookies, SESSION_COOKIE } from './cookies.js';
import type { SessionData, SessionUser } from './core/session-data.js';

// Для серверных компонентов: только читаем cookie (middleware держит её свежей).
// Ставить cookie в серверных компонентах Next.js нельзя — поэтому здесь без refresh.
// При входе по паролю обновления нет, поэтому срок сессии проверяем здесь же.
export async function getUser(
  cookieHeader: string | null,
  options: LoadConfigOptions = {},
): Promise<SessionUser | null> {
  const env = resolveEnv(options);
  const cookieSecret = requireCookieSecret(env);
  const sealed = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!sealed) return null;
  const data = await unseal<SessionData>(sealed, cookieSecret);
  if (!data) return null;
  if (authMode({ env }) === 'password' && !isSessionAlive(data, Date.now())) return null;
  return data.user ?? null;
}
