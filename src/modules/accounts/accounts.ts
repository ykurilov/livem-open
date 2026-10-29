import { eq } from "drizzle-orm";
import type { AccountStore, PasswordAccount } from "../../auth";
import { hashPassword } from "../../auth/password/password-hash";
import { isEmailAllowed } from "../access/access";
import type { DatabaseExecutor } from "../platform/db";
import { accounts } from "./schema";

export const MIN_PASSWORD_LENGTH = 10;

/** Ошибка ввода с понятным текстом для человека. */
export class AccountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountInputError";
  }
}

export async function findAccountByEmail(db: DatabaseExecutor, email: string): Promise<PasswordAccount | null> {
  const [row] = await db.select().from(accounts).where(eq(accounts.email, email.trim().toLowerCase())).limit(1);
  if (!row) return null;
  return { id: row.id, email: row.email, passwordHash: row.passwordHash, ...(row.name ? { name: row.name } : {}) };
}

/** Хранилище учётных записей для модуля входа. */
export function accountStore(db: DatabaseExecutor): AccountStore {
  return { findByEmail: (email) => findAccountByEmail(db, email) };
}

/**
 * Задаёт пароль почте из ALLOWED_EMAILS: создаёт учётную запись или меняет пароль существующей.
 * Остальные сессии продолжают действовать до конца срока; выйти везде — сменить AUTH_COOKIE_SECRET.
 */
export async function setPassword(
  db: DatabaseExecutor,
  input: { email: string; password: string; allowedEmails: Set<string> },
): Promise<{ email: string; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new AccountInputError(`Это не похоже на почту: «${input.email}»`);
  if (!isEmailAllowed(email, input.allowedEmails)) {
    throw new AccountInputError(
      `Почты ${email} нет в ALLOWED_EMAILS. Впишите её в .env (ALLOWED_EMAILS=${email}), перезапустите приложение и повторите команду.`,
    );
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new AccountInputError(`Пароль слишком короткий: нужно не меньше ${MIN_PASSWORD_LENGTH} знаков.`);
  }

  const passwordHash = await hashPassword(input.password);
  const existing = await findAccountByEmail(db, email);
  await db
    .insert(accounts)
    .values({ email, passwordHash })
    .onConflictDoUpdate({ target: accounts.email, set: { passwordHash, updatedAt: new Date() } });
  return { email, created: existing === null };
}
