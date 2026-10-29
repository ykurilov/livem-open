import { describe, expect, it } from "vitest";
import { unseal } from "../../auth/core/cookie-seal";
import { FLOW_COOKIE } from "../../auth/cookies";
import { SILENT_CHECK_COOKIE } from "./access";
import { createSilentLogin } from "./silent-login";

const env = {
  AUTH_URL: "https://auth.example.com",
  AUTH_APP_URL: "https://app.example.com",
  AUTH_COOKIE_SECRET: "x".repeat(40),
};

function cookieValue(response: Response, name: string): string {
  const header = response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`));
  if (!header) throw new Error(`Нет cookie ${name}`);
  return header.split(";")[0]!.slice(name.length + 1);
}

describe("тихая проверка единого входа", () => {
  const silent = createSilentLogin({ env });

  async function run(next?: string) {
    const url = new URL("https://app.example.com/api/auth/silent");
    if (next) url.searchParams.set("next", next);
    return silent(new Request(url));
  }

  it("отправляет на /authorize сервиса входа с prompt=none и проверочным кодом", async () => {
    const response = await run("/bots");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://auth.example.com");
    expect(location.pathname).toBe("/authorize");
    expect(location.searchParams.get("prompt")).toBe("none");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/auth/callback");
  });

  it("кладёт в cookie потока то же состояние, что в адресе, и адрес возврата — модуль входа разберёт его сам", async () => {
    const response = await run("/bots?tab=1");
    const location = new URL(response.headers.get("location")!);
    const flow = await unseal<{ verifier: string; state: string; next: string }>(
      cookieValue(response, FLOW_COOKIE),
      env.AUTH_COOKIE_SECRET,
    );
    expect(flow?.state).toBe(location.searchParams.get("state"));
    expect(flow?.next).toBe("/bots?tab=1");
    expect(flow?.verifier).toBeTruthy();
  });

  it("ставит метку «тихая проверка уже была», чтобы не было бесконечных перенаправлений", async () => {
    const response = await run("/");
    expect(response.headers.getSetCookie().some((entry) => entry.startsWith(`${SILENT_CHECK_COOKIE}=1`))).toBe(true);
  });

  it("чужой адрес возврата заменяет на главную", async () => {
    const response = await run("//evil.example.com");
    const flow = await unseal<{ next: string }>(cookieValue(response, FLOW_COOKIE), env.AUTH_COOKIE_SECRET);
    expect(flow?.next).toBe("/");
  });
});

describe("тихая проверка при входе по паролю", () => {
  const silent = createSilentLogin({ env: { AUTH_COOKIE_SECRET: "x".repeat(40) } });

  it("единого входа нет — сразу экран входа с адресом возврата", async () => {
    const response = await silent(new Request("https://app.example.com/api/auth/silent?next=%2Fbots%3Ftab%3D1"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?next=%2Fbots%3Ftab%3D1");
    expect(response.headers.getSetCookie().some((entry) => entry.startsWith(`${FLOW_COOKIE}=`))).toBe(false);
  });
});
