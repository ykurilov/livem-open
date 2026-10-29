import { authMode } from './core/auth-mode.js';
import { loadModuleConfig, requireCookieSecret, resolveEnv, type LoadConfigOptions } from './core/config.js';
import { OidcClient } from './core/oidc-client.js';
import { createPkce } from './core/pkce.js';
import { seal, unseal } from './core/cookie-seal.js';
import { buildSessionData, type SessionData } from './core/session-data.js';
import {
  SESSION_COOKIE,
  FLOW_COOKIE,
  SESSION_MAX_AGE,
  FLOW_MAX_AGE,
  serializeCookie,
  clearCookie,
  parseCookies,
  isSecureRequest,
} from './cookies.js';
import { createPasswordHandlers } from './password/password-handlers.js';
import type { AccountStore } from './password/password-session.js';

interface FlowState {
  verifier: string;
  state: string;
  next: string;
}

// next принимаем только как относительный путь внутри приложения — защита от
// открытого редиректа. Всё, что не начинается с одиночного '/', заменяем на '/'.
function safeNext(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

export interface AuthHandlerOptions extends LoadConfigOptions {
  // Учётные записи для входа по паролю; при едином входе не нужны.
  accounts?: AccountStore;
}

// GET: login, callback, logout, me. POST: login — форма входа по паролю (при едином входе — 404).
export function createAuthHandlers(options: AuthHandlerOptions = {}) {
  if (authMode(options) === 'password') {
    if (!options.accounts) {
      throw new Error('Вход по паролю: передайте в createAuthHandlers хранилище учётных записей (accounts)');
    }
    return createPasswordHandlers({ cookieSecret: requireCookieSecret(resolveEnv(options)), accounts: options.accounts });
  }
  return createSsoHandlers(options);
}

function createSsoHandlers(options: LoadConfigOptions) {
  const config = loadModuleConfig(options);
  const client = new OidcClient(config);

  async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split('/').filter(Boolean).pop();
    const secure = isSecureRequest(url);

    if (action === 'login') return login(url, secure);
    if (action === 'callback') return callback(request, url, secure);
    if (action === 'logout') return logout(request, secure);
    if (action === 'me') return me(request);
    return new Response('Not found', { status: 404 });
  }

  async function login(url: URL, secure: boolean): Promise<Response> {
    const pkce = await createPkce();
    const flow: FlowState = {
      verifier: pkce.verifier,
      state: pkce.state,
      next: safeNext(url.searchParams.get('next')),
    };
    const sealed = await seal(flow, config.cookieSecret);
    const cookie = serializeCookie(FLOW_COOKIE, sealed, { maxAgeSeconds: FLOW_MAX_AGE, secure });
    return redirect(
      client.buildAuthorizeUrl({ challenge: pkce.challenge, state: pkce.state }),
      [cookie],
    );
  }

  async function callback(request: Request, url: URL, secure: boolean): Promise<Response> {
    const clearFlow = clearCookie(FLOW_COOKIE, secure);
    // Любой сбой валидации/обмена — на / с чисткой ТОЛЬКО auth_flow, без деталей
    // наружу. auth_session не трогаем: иначе подброшенная ссылка на
    // /api/auth/callback?error=x разлогинивала бы уже вошедшего пользователя.
    const fail = () => redirect(`${config.appUrl}/`, [clearFlow]);

    if (url.searchParams.get('error')) return fail();

    const cookies = parseCookies(request.headers.get('cookie'));
    const sealed = cookies[FLOW_COOKIE];
    if (!sealed) return fail();
    const flow = await unseal<FlowState>(sealed, config.cookieSecret);
    if (!flow) return fail();

    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!code || !state || state !== flow.state) return fail();

    try {
      const tokens = await client.exchangeCode({ code, verifier: flow.verifier });
      const data = buildSessionData({ ...tokens, now: new Date() });
      if (!data) return fail();
      const session = await seal(data, config.cookieSecret);
      return redirect(`${config.appUrl}${flow.next}`, [
        serializeCookie(SESSION_COOKIE, session, { maxAgeSeconds: SESSION_MAX_AGE, secure }),
        clearFlow,
      ]);
    } catch {
      return fail();
    }
  }

  async function logout(request: Request, secure: boolean): Promise<Response> {
    const cookies = parseCookies(request.headers.get('cookie'));
    const sealed = cookies[SESSION_COOKIE];
    if (sealed) {
      const data = await unseal<SessionData>(sealed, config.cookieSecret);
      if (data?.refreshToken) await client.revoke(data.refreshToken);
    }
    return redirect(client.buildLogoutUrl(), [clearCookie(SESSION_COOKIE, secure)]);
  }

  async function me(request: Request): Promise<Response> {
    const cookies = parseCookies(request.headers.get('cookie'));
    const sealed = cookies[SESSION_COOKIE];
    const data = sealed ? await unseal<SessionData>(sealed, config.cookieSecret) : null;
    if (!data) {
      return new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ user: data.user }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  async function POST(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  }

  return { GET, POST };
}
