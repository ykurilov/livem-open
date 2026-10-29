// Кто и куда может заходить. Чистые правила без обращений к Next.js, чтобы их можно было проверять тестами.

export const SILENT_CHECK_COOKIE = "auth_silent_checked";
/** Сколько помним, что тихая проверка единого входа уже была. */
export const SILENT_CHECK_MAX_AGE_SECONDS = 10 * 60;

export function parseAllowedEmails(raw: string | undefined): Set<string> {
  const emails = (raw ?? "")
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== "");
  return new Set(emails);
}

export function isEmailAllowed(email: string | undefined, allowed: Set<string>): boolean {
  return email !== undefined && allowed.has(email.toLowerCase());
}

const PUBLIC_PREFIXES = ["/api/health", "/api/auth", "/login", "/api/webhooks", "/api/integrations", "/i"];

/**
 * Адреса, которые открыты без входа: проверка здоровья, сам вход, экран входа, вебхуки мессенджеров и школ (секрет в адресе)
 * и короткие ссылки `/i/<код>` для людей из мессенджера.
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export interface AccessInput {
  pathname: string;
  search: string;
  user: { email?: string } | null;
  allowedEmails: Set<string>;
  silentCheckDone: boolean;
}

export type AccessDecision =
  | { kind: "allow" }
  | { kind: "redirect"; to: string }
  | { kind: "reject"; status: 401 | 403 };

export function decideAccess(input: AccessInput): AccessDecision {
  if (isPublicPath(input.pathname)) return { kind: "allow" };

  const isApi = input.pathname.startsWith("/api/");
  const next = encodeURIComponent(`${input.pathname}${input.search}`);

  if (!input.user) {
    if (isApi) return { kind: "reject", status: 401 };
    // Экран «Войти» показываем только после тихой проверки: человек, уже вошедший в единый вход, его не увидит
    return { kind: "redirect", to: input.silentCheckDone ? `/login?next=${next}` : `/api/auth/silent?next=${next}` };
  }

  if (!isEmailAllowed(input.user.email, input.allowedEmails)) {
    return isApi ? { kind: "reject", status: 403 } : { kind: "redirect", to: "/login?error=access_denied" };
  }
  return { kind: "allow" };
}
