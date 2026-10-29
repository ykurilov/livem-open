import { authMode } from "../../auth/core/auth-mode";
import { loadModuleConfig, type LoadConfigOptions } from "../../auth/core/config";
import { seal } from "../../auth/core/cookie-seal";
import { OidcClient } from "../../auth/core/oidc-client";
import { createPkce } from "../../auth/core/pkce";
import { FLOW_COOKIE, FLOW_MAX_AGE, isSecureRequest, serializeCookie } from "../../auth/cookies";
import { SILENT_CHECK_COOKIE, SILENT_CHECK_MAX_AGE_SECONDS } from "./access";

// Модуль входа не умеет `prompt=none`, а править его нельзя. Поэтому тихую проверку делаем сами на его деталях:
// то же состояние потока в той же cookie, и обычный /api/auth/callback модуля разберёт ответ.
// Если у человека нет живого единого входа, сервис вернёт `login_required`, модуль отправит на «/»,
// а метка из SILENT_CHECK_COOKIE не даст начать проверку заново.
// При входе по паролю единого входа нет: сразу экран входа.

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function createSilentLogin(options: LoadConfigOptions = {}) {
  if (authMode(options) === "password") {
    return async function toLoginPage(request: Request): Promise<Response> {
      const next = safeNext(new URL(request.url).searchParams.get("next"));
      return new Response(null, { status: 302, headers: { location: `/login?next=${encodeURIComponent(next)}` } });
    };
  }
  const config = loadModuleConfig(options);
  const client = new OidcClient(config);

  return async function silentLogin(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secure = isSecureRequest(url);
    const pkce = await createPkce();
    const flow = { verifier: pkce.verifier, state: pkce.state, next: safeNext(url.searchParams.get("next")) };

    const authorizeUrl = new URL(client.buildAuthorizeUrl({ challenge: pkce.challenge, state: pkce.state }));
    authorizeUrl.searchParams.set("prompt", "none");

    const headers = new Headers({ location: authorizeUrl.toString() });
    headers.append(
      "set-cookie",
      serializeCookie(FLOW_COOKIE, await seal(flow, config.cookieSecret), { maxAgeSeconds: FLOW_MAX_AGE, secure }),
    );
    headers.append(
      "set-cookie",
      serializeCookie(SILENT_CHECK_COOKIE, "1", { maxAgeSeconds: SILENT_CHECK_MAX_AGE_SECONDS, secure }),
    );
    return new Response(null, { status: 302, headers });
  };
}

