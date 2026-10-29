import type { ModuleConfig } from './config.js';

// Фиксированный путь callback — должен совпадать с деривацией redirect_uri на
// стороне сервиса (Admin API строит именно /api/auth/callback).
export const CALLBACK_PATH = '/api/auth/callback';

export interface TokenSet {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}

// Ошибка обмена/обновления. error — код из тела ответа сервиса (invalid_grant и пр.).
export class OidcError extends Error {
  readonly error: string;
  constructor(error: string, message?: string) {
    super(message ?? error);
    this.name = 'OidcError';
    this.error = error;
  }
}

interface RawTokenResponse {
  access_token: string;
  id_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export class OidcClient {
  // Поле объявлено отдельно, а не сокращённой записью в конструкторе: та
  // компилируется в код, а не стирается вместе с типами, и приложения с
  // erasableSyntaxOnly (Next.js со скриптами на node --strip-types) на ней
  // спотыкаются.
  private readonly config: ModuleConfig;

  constructor(config: ModuleConfig) {
    this.config = config;
  }

  private get redirectUri(): string {
    return `${this.config.appUrl}${CALLBACK_PATH}`;
  }

  buildAuthorizeUrl(params: { challenge: string; state: string }): string {
    const url = new URL('/authorize', this.config.authUrl);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('code_challenge', params.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // Приложению нужен профиль пользователя (getUser отдаёт email/имя),
    // поэтому запрашиваем profile и email, а не только базовый openid.
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', params.state);
    return url.toString();
  }

  buildLogoutUrl(): string {
    const url = new URL('/logout', this.config.authUrl);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('post_logout_redirect_uri', `${this.config.appUrl}/`);
    return url.toString();
  }

  async exchangeCode(params: { code: string; verifier: string }): Promise<TokenSet> {
    return this.token({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: this.redirectUri,
      client_id: this.config.clientId,
      code_verifier: params.verifier,
    });
  }

  async refreshTokens(refreshToken: string): Promise<TokenSet> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  // Любой сбой нормализуем в OidcError, чтобы вызывающий код работал с одним
  // типом ошибки: сеть → network_error, битое тело при успехе → invalid_response.
  private async token(body: Record<string, string>): Promise<TokenSet> {
    let res: Response;
    try {
      res = await this.config.fetch(`${this.config.authUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new OidcError('network_error', 'Не удалось соединиться с сервисом авторизации');
    }
    if (!res.ok) {
      let error = 'invalid_grant';
      try {
        const data = (await res.json()) as { error?: string };
        if (typeof data.error === 'string') error = data.error;
      } catch {
        // тело не JSON — оставляем дефолт
      }
      throw new OidcError(error);
    }
    let data: RawTokenResponse;
    try {
      data = (await res.json()) as RawTokenResponse;
    } catch {
      throw new OidcError('invalid_response', 'Сервис авторизации вернул невалидный JSON');
    }
    return {
      accessToken: data.access_token,
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  // Отзыв не должен ломать logout: сеть/сервис могли отвалиться, но локально мы
  // всё равно чистим сессию. Поэтому любые ошибки проглатываем.
  async revoke(refreshToken: string): Promise<void> {
    try {
      await this.config.fetch(`${this.config.authUrl}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: refreshToken }),
      });
    } catch {
      /* logout продолжается локально */
    }
  }
}
