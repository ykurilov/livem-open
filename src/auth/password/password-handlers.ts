import { seal, unseal } from '../core/cookie-seal.js';
import type { SessionData } from '../core/session-data.js';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  clearCookie,
  isSecureRequest,
  parseCookies,
  serializeCookie,
} from '../cookies.js';
import { createLoginAttempts, type LoginAttempts } from './login-attempts.js';
import { decoyHash, verifyPassword } from './password-hash.js';
import { isSessionAlive, passwordSessionData, type AccountStore } from './password-session.js';

export interface PasswordHandlerOptions {
  cookieSecret: string;
  accounts: AccountStore;
  attempts?: LoginAttempts;
  now?: () => number;
}

// Длиннее не бывает настоящих паролей; ограничение не даёт гонять scrypt по мегабайтам.
const MAX_PASSWORD_LENGTH = 1024;
const LOGIN_PAGE = '/login';

function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

// Адреса перехода относительные: приложение может стоять за любым прокси и доменом.
function redirect(location: string, status: 302 | 303, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status, headers });
}

function loginPage(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `${LOGIN_PAGE}?${query}` : LOGIN_PAGE;
}

// Адрес человека: за прокси (Caddy, Nginx) — первый из X-Forwarded-For.
function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

// Форма входа должна прийти со своего же сайта. Браузер всегда шлёт Origin у POST формы;
// без Origin запрос пришёл не из браузера, и подделка от имени человека невозможна.
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [request.headers.get('x-forwarded-host'), request.headers.get('host'), new URL(request.url).host];
  return hosts.some((host) => host?.split(',')[0]?.trim() === originHost);
}

export function createPasswordHandlers(options: PasswordHandlerOptions) {
  const { cookieSecret, accounts } = options;
  const attempts = options.attempts ?? createLoginAttempts();
  const now = options.now ?? Date.now;

  async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split('/').filter(Boolean).pop();
    const secure = isSecureRequest(url);

    if (action === 'login') {
      const next = url.searchParams.get('next');
      return redirect(loginPage(next ? { next: safeNext(next) } : {}), 302);
    }
    if (action === 'logout') return redirect(LOGIN_PAGE, 302, [clearCookie(SESSION_COOKIE, secure)]);
    if (action === 'me') return me(request);
    return new Response('Not found', { status: 404 });
  }

  async function POST(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split('/').filter(Boolean).pop();
    if (action !== 'login') return new Response('Not found', { status: 404 });
    if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return redirect(loginPage({ error: 'invalid' }), 303);
    }
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const password = String(form.get('password') ?? '');
    const next = safeNext(form.get('next')?.toString());
    const back = (error: string) => redirect(loginPage(next === '/' ? { error } : { error, next }), 303);

    if (!email || !password || password.length > MAX_PASSWORD_LENGTH) return back('invalid');

    const ip = clientIp(request);
    if (attempts.retryAfterMs(email, ip) > 0) return back('too_many');

    const account = await accounts.findByEmail(email);
    // Незнакомая почта тоже проходит проверку пароля: по времени ответа её не отличить
    const valid = await verifyPassword(password, account?.passwordHash ?? (await decoyHash()));
    if (!account || !valid) {
      attempts.recordFailure(email, ip);
      return back('invalid');
    }

    attempts.recordSuccess(email, ip);
    const session = await seal(passwordSessionData(account, now()), cookieSecret);
    return redirect(next, 303, [
      serializeCookie(SESSION_COOKIE, session, { maxAgeSeconds: SESSION_MAX_AGE, secure: isSecureRequest(url) }),
    ]);
  }

  async function me(request: Request): Promise<Response> {
    const sealed = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
    const data = sealed ? await unseal<SessionData>(sealed, cookieSecret) : null;
    if (!data || !isSessionAlive(data, now())) {
      return Response.json({ error: 'unauthenticated' }, { status: 401 });
    }
    return Response.json({ user: data.user });
  }

  return { GET, POST };
}

// Прослойка для входа по паролю: обновлять нечего, только стереть истёкшую сессию.
export function createPasswordMiddleware(options: { cookieSecret: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  return async function middleware(request: Request, next: () => Response): Promise<Response> {
    const sealed = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
    if (!sealed) return next();
    const data = await unseal<SessionData>(sealed, options.cookieSecret);
    const response = next();
    if (!data || !isSessionAlive(data, now())) {
      response.headers.append('set-cookie', clearCookie(SESSION_COOKIE, isSecureRequest(new URL(request.url))));
    }
    return response;
  };
}
