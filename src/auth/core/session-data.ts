import { decodeJwtClaims } from './claims.js';
import type { TokenSet } from './oidc-client.js';

export interface SessionUser {
  id: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  roles: string[];
}

export interface SessionData {
  user: SessionUser;
  accessToken: string;
  refreshToken: string;
  // Абсолютный момент истечения access-токена (мс эпохи) — по нему middleware
  // решает, пора ли обновлять.
  accessTokenExpiresAt: number;
}

export interface BuildSessionInput extends TokenSet {
  now: Date;
}

// user собираем из claims: профиль (email/name/verified) — из id_token, роли —
// из access_token. Подпись не проверяем (см. claims.ts).
export function buildSessionData(input: BuildSessionInput): SessionData | null {
  const id = decodeJwtClaims(input.idToken);
  const access = decodeJwtClaims(input.accessToken);
  if (!id || !id.sub) return null;

  const user: SessionUser = { id: id.sub, roles: access?.roles ?? [] };
  if (id.email !== undefined) user.email = id.email;
  if (id.email_verified !== undefined) user.emailVerified = id.email_verified;
  if (id.name !== undefined) user.name = id.name;

  return {
    user,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    accessTokenExpiresAt: input.now.getTime() + input.expiresIn * 1000,
  };
}
