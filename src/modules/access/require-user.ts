import type { SessionUser } from "../../auth";
import { isEmailAllowed } from "./access";

export interface CabinetUser {
  id: string;
  /** Всегда строчными буквами. */
  email: string;
  name?: string;
}

export class AccessError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403) {
    super(status === 401 ? "Нужно войти" : "Этому адресу вход закрыт");
    this.name = "AccessError";
    this.status = status;
  }
}

export interface RequireUserDependencies {
  allowedEmails: Set<string>;
  getUser(cookieHeader: string | null): Promise<SessionUser | null>;
}

export async function requireUserFromCookie(
  cookieHeader: string | null,
  deps: RequireUserDependencies,
): Promise<CabinetUser> {
  const user = await deps.getUser(cookieHeader);
  if (!user) throw new AccessError(401);
  if (!user.email || !isEmailAllowed(user.email, deps.allowedEmails)) throw new AccessError(403);
  return { id: user.id, email: user.email.toLowerCase(), name: user.name };
}

/** Для обработчиков API: `catch (error) { return accessErrorResponse(error) ?? Promise.reject(error) }`. */
export function accessErrorResponse(error: unknown): Response | null {
  if (!(error instanceof AccessError)) return null;
  return Response.json({ error: error.status === 401 ? "unauthenticated" : "forbidden" }, { status: error.status });
}
