// Хеш пароля: scrypt с солью. В базе лежит только строка
// "scrypt$<N>$<r>$<p>$<соль>$<хеш>" (соль и хеш в base64url), сам пароль нигде не хранится.
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const COST = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// Предел стоимости из хеша: испорченная запись в базе не должна съесть память процесса.
const MAX_N = 2 ** 20;

function derive(password: string, salt: Buffer, cost: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...cost, maxmem: 256 * cost.N * cost.r * cost.p };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) {
    return false;
  }
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
  try {
    return timingSafeEqual(await derive(password, salt, { N, r, p }), expected);
  } catch {
    return false;
  }
}

// Проверка пароля «в пустоту» для незнакомой почты: ответ занимает столько же времени,
// и по задержке нельзя узнать, есть ли такая учётная запись.
let decoy: Promise<string> | undefined;
export function decoyHash(): Promise<string> {
  return (decoy ??= hashPassword(randomBytes(16).toString('hex')));
}
