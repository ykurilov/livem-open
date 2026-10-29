import { authMode } from './core/auth-mode.js';
import { loadModuleConfig, requireCookieSecret, resolveEnv, type LoadConfigOptions } from './core/config.js';
import { OidcClient } from './core/oidc-client.js';
import { seal, unseal } from './core/cookie-seal.js';
import { buildSessionData, type SessionData } from './core/session-data.js';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  serializeCookie,
  clearCookie,
  parseCookies,
  isSecureRequest,
} from './cookies.js';
import { createPasswordMiddleware } from './password/password-handlers.js';

// За сколько до истечения access-токена начинаем обновление.
const REFRESH_SKEW_MS = 120_000;

// Фабрика ответа «пропустить запрос дальше». В Next.js приложение передаёт
// () => NextResponse.next(); сами мы такой ответ не соберём без импорта
// next/server — обычный Response 200 из middleware Next.js трактует как
// финальный ответ, а не как «продолжить».
export type NextHandler = () => Response;

export interface MiddlewareOptions extends LoadConfigOptions {
  // Префиксы путей, требующих входа. При отсутствии сессии/провале refresh на
  // таких путях — редирект на login; остальные проходят анонимно.
  protect?: string[];
}

function isProtected(pathname: string, protect: string[]): boolean {
  return protect.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/'));
}

// Пропустить запрос дальше: берём ответ next() и дописываем к нему set-cookie.
function passThrough(next: NextHandler, setCookies: string[] = []): Response {
  const res = next();
  for (const c of setCookies) res.headers.append('set-cookie', c);
  return res;
}

function toLogin(appUrl: string, pathname: string, clearCookieStr: string): Response {
  const url = new URL('/api/auth/login', appUrl);
  url.searchParams.set('next', pathname);
  const headers = new Headers({ location: url.toString() });
  headers.append('set-cookie', clearCookieStr);
  return new Response(null, { status: 302, headers });
}

export function createAuthMiddleware(options: MiddlewareOptions = {}) {
  // При входе по паролю обновлять нечего: прослойка только стирает истёкшую сессию.
  // protect здесь не нужен приложению: куда пускать, решает его proxy.
  if (authMode(options) === 'password') {
    return createPasswordMiddleware({ cookieSecret: requireCookieSecret(resolveEnv(options)) });
  }
  const config = loadModuleConfig(options);
  const client = new OidcClient(config);
  const protect = options.protect ?? [];
  // Дедуп одновременных обновлений одного refresh-токена в этом процессе.
  const inflight = new Map<string, Promise<SessionData | null>>();

  async function refreshOnce(data: SessionData): Promise<SessionData | null> {
    const key = data.refreshToken;
    const existing = inflight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const tokens = await client.refreshTokens(data.refreshToken);
        return buildSessionData({ ...tokens, now: new Date() });
      } catch {
        return null;
      }
    })().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  return async function middleware(request: Request, next: NextHandler): Promise<Response> {
    const url = new URL(request.url);
    const secure = isSecureRequest(url);
    const protectedPath = isProtected(url.pathname, protect);

    const cookies = parseCookies(request.headers.get('cookie'));
    const sealed = cookies[SESSION_COOKIE];
    const data = sealed ? await unseal<SessionData>(sealed, config.cookieSecret) : null;

    if (!data) {
      return protectedPath
        ? toLogin(config.appUrl, url.pathname, clearCookie(SESSION_COOKIE, secure))
        : passThrough(next);
    }

    // Токен ещё свежий — пропускаем без обновления.
    if (data.accessTokenExpiresAt - Date.now() > REFRESH_SKEW_MS) {
      return passThrough(next);
    }

    const refreshed = await refreshOnce(data);
    if (!refreshed) {
      // Сессия отозвана/истекла: чистим cookie. protect -> на login, иначе анонимно.
      const clear = clearCookie(SESSION_COOKIE, secure);
      return protectedPath
        ? toLogin(config.appUrl, url.pathname, clear)
        : passThrough(next, [clear]);
    }

    const cookie = serializeCookie(SESSION_COOKIE, await seal(refreshed, config.cookieSecret), {
      maxAgeSeconds: SESSION_MAX_AGE,
      secure,
    });
    return passThrough(next, [cookie]);
  };
}
