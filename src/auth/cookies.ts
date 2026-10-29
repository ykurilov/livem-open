// Имена и (де)сериализация cookie. Атрибуты по спеке: HttpOnly, SameSite=Lax,
// Path=/. Secure добавляем всегда, кроме локальной http-разработки.
export const SESSION_COOKIE = 'auth_session';
export const FLOW_COOKIE = 'auth_flow';

export const SESSION_MAX_AGE = 30 * 24 * 3600; // 30 дней
export const FLOW_MAX_AGE = 10 * 60; // 10 минут

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

// Cookie для удаления: пустое значение + Max-Age=0.
export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', { maxAgeSeconds: 0, secure });
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

// Secure выключаем только для http://localhost (иначе браузер не примет cookie
// на локалке). Всё остальное — Secure.
export function isSecureRequest(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
}
