import { resolveEnv, type LoadConfigOptions } from './config.js';

// Способ входа: логин и пароль (своя учётная запись в базе приложения) или свой сервис единого входа (OIDC).
export type AuthMode = 'password' | 'sso';

// AUTH_MODE главнее. Без него — единый вход только там, где задан его адрес AUTH_URL (установки,
// подключённые к SSO раньше, продолжают работать без правки .env); у новой установки — пароль.
export function authMode(options: LoadConfigOptions = {}): AuthMode {
  const env = resolveEnv(options);
  const raw = env.AUTH_MODE?.trim().toLowerCase();
  if (raw === 'password' || raw === 'sso') return raw;
  if (raw) throw new Error(`AUTH_MODE: ожидается password или sso, получено: ${env.AUTH_MODE}`);
  return env.AUTH_URL && env.AUTH_URL.trim() !== '' ? 'sso' : 'password';
}
