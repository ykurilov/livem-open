import { SESSION_MAX_AGE } from '../cookies.js';
import type { SessionData } from '../core/session-data.js';

// Учётная запись для входа по паролю. Хранит её приложение (в своей базе) и передаёт модулю
// через AccountStore — сам модуль базу не знает.
export interface PasswordAccount {
  id: string;
  /** Строчными буквами. */
  email: string;
  name?: string;
  passwordHash: string;
}

export interface AccountStore {
  /** Почта уже приведена к строчным буквам. */
  findByEmail(email: string): Promise<PasswordAccount | null>;
}

// Сессия входа по паролю — та же SessionData, что у единого входа, чтобы getUser и остальной код
// не различали способы. Токенов здесь нет: строки пустые, а accessTokenExpiresAt — конец сессии.
export function passwordSessionData(account: PasswordAccount, nowMs: number): SessionData {
  const user: SessionData['user'] = { id: account.id, email: account.email, roles: [] };
  if (account.name) user.name = account.name;
  return { user, accessToken: '', refreshToken: '', accessTokenExpiresAt: nowMs + SESSION_MAX_AGE * 1000 };
}

export function isSessionAlive(data: SessionData, nowMs: number): boolean {
  return typeof data.accessTokenExpiresAt === 'number' && data.accessTokenExpiresAt > nowMs;
}
