import { NextResponse, type NextRequest } from "next/server";
import { createAuthMiddleware, getUser } from "@/auth";
import { decideAccess, isPublicPath, parseAllowedEmails, SILENT_CHECK_COOKIE } from "@/modules/access";

// Модуль входа читает настройки при создании, поэтому создаём его при первом закрытом запросе:
// открытые адреса (проверка здоровья, вебхуки) работают, даже если вход ещё не настроен.
let refreshSession: ReturnType<typeof createAuthMiddleware> | undefined;

function sessionWasCleared(response: Response): boolean {
  return response.headers.getSetCookie().some((cookie) => /^auth_session=;/.test(cookie));
}

function withCookiesFrom(source: Response, target: Response): Response {
  for (const cookie of source.headers.getSetCookie()) target.headers.append("set-cookie", cookie);
  return target;
}

export async function proxy(request: NextRequest): Promise<Response> {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  refreshSession ??= createAuthMiddleware({ env: process.env });
  // Обновляет просроченный токен и кладёт свежую cookie в ответ
  const passed = await refreshSession(request, () => NextResponse.next());

  const cookieHeader = request.headers.get("cookie");
  const decision = decideAccess({
    pathname,
    search,
    user: sessionWasCleared(passed) ? null : await getUser(cookieHeader),
    allowedEmails: parseAllowedEmails(process.env.ALLOWED_EMAILS),
    silentCheckDone: request.cookies.has(SILENT_CHECK_COOKIE),
  });

  switch (decision.kind) {
    case "allow":
      return passed;
    case "redirect":
      return withCookiesFrom(passed, NextResponse.redirect(new URL(decision.to, request.url)));
    case "reject":
      return withCookiesFrom(
        passed,
        NextResponse.json({ error: decision.status === 401 ? "unauthenticated" : "forbidden" }, { status: decision.status }),
      );
  }
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
