import { beforeAll, describe, expect, it } from "vitest";
import { seal } from "./core/cookie-seal";
import { authMode, createAuthHandlers, createAuthMiddleware, getUser, type AccountStore, type PasswordAccount } from "./index";
import { hashPassword } from "./password/password-hash";

const SECRET = "s".repeat(40);
const env = { AUTH_COOKIE_SECRET: SECRET };
const APP = "https://app.example.com";

let owner: PasswordAccount;
const accounts: AccountStore = {
  findByEmail: async (email) => (email === owner.email ? owner : null),
};

beforeAll(async () => {
  owner = { id: "acc-1", email: "owner@example.com", name: "Владелец", passwordHash: await hashPassword("correct-horse-battery") };
});

function loginRequest(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${APP}/api/auth/login`, {
    method: "POST",
    headers: { origin: APP, host: "app.example.com", "x-forwarded-for": "203.0.113.7", ...headers },
    body: new URLSearchParams(fields),
  });
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
}

describe("способ входа", () => {
  it("по умолчанию — логин и пароль", () => {
    expect(authMode({ env: {} })).toBe("password");
  });

  it("задан адрес сервиса единого входа — единый вход, как на старых установках", () => {
    expect(authMode({ env: { AUTH_URL: "https://auth.example.com" } })).toBe("sso");
  });

  it("AUTH_MODE главнее", () => {
    expect(authMode({ env: { AUTH_MODE: "password", AUTH_URL: "https://auth.example.com" } })).toBe("password");
    expect(authMode({ env: { AUTH_MODE: "SSO" } })).toBe("sso");
    expect(() => authMode({ env: { AUTH_MODE: "magic" } })).toThrow(/AUTH_MODE/);
  });
});

describe("вход по логину и паролю", () => {
  const handlers = () => createAuthHandlers({ env, accounts });

  it("верный пароль: защищённая cookie сессии и переход туда, куда шёл человек", async () => {
    const response = await handlers().POST(loginRequest({ email: " Owner@Example.com ", password: "correct-horse-battery", next: "/bots" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/bots");
    const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith("auth_session="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).not.toContain("owner@example.com");

    const user = await getUser(cookieHeader(response), { env });
    expect(user).toMatchObject({ id: "acc-1", email: "owner@example.com", name: "Владелец" });
  });

  it("неверный пароль и незнакомая почта — одинаковый ответ, без cookie", async () => {
    for (const fields of [
      { email: "owner@example.com", password: "wrong-password" },
      { email: "nobody@example.com", password: "correct-horse-battery" },
    ]) {
      const response = await handlers().POST(loginRequest({ ...fields, next: "/bots" }));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login?error=invalid&next=%2Fbots");
      expect(response.headers.getSetCookie().some((entry) => entry.startsWith("auth_session="))).toBe(false);
    }
  });

  it("после серии неудач даже верный пароль ждёт паузу", async () => {
    const { POST } = handlers();
    for (let i = 0; i < 5; i++) await POST(loginRequest({ email: "owner@example.com", password: `guess-${i}` }));
    const response = await POST(loginRequest({ email: "owner@example.com", password: "correct-horse-battery" }));
    expect(response.headers.get("location")).toMatch(/^\/login\?error=too_many/);
    expect(response.headers.getSetCookie().some((entry) => entry.startsWith("auth_session="))).toBe(false);
  });

  it("форма с чужого сайта отклоняется", async () => {
    const response = await handlers().POST(
      loginRequest({ email: "owner@example.com", password: "correct-horse-battery" }, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("переход после входа — только внутри приложения", async () => {
    const response = await handlers().POST(loginRequest({ email: "owner@example.com", password: "correct-horse-battery", next: "//evil.example/x" }));
    expect(response.headers.get("location")).toBe("/");
  });

  it("GET /api/auth/login ведёт на экран входа", async () => {
    const response = await handlers().GET(new Request(`${APP}/api/auth/login?next=%2Fbots`));
    expect(response.headers.get("location")).toBe("/login?next=%2Fbots");
  });

  it("выход стирает cookie и ведёт на экран входа", async () => {
    const response = await handlers().GET(new Request(`${APP}/api/auth/logout`));
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.getSetCookie().some((entry) => /^auth_session=;.*Max-Age=0/.test(entry))).toBe(true);
  });

  it("без хранилища учётных записей модуль объясняет, чего не хватает", () => {
    expect(() => createAuthHandlers({ env })).toThrow(/учётн/);
  });

  it("без секрета cookie модуль объясняет, чего не хватает", () => {
    expect(() => createAuthHandlers({ env: {}, accounts })).toThrow(/AUTH_COOKIE_SECRET/);
  });
});

describe("сессия входа по паролю", () => {
  const sessionOf = (expiresAt: number) => ({
    user: { id: "acc-1", email: "owner@example.com", roles: [] },
    accessToken: "",
    refreshToken: "",
    accessTokenExpiresAt: expiresAt,
  });

  it("истёкшая сессия — не вход, и прослойка стирает её cookie", async () => {
    const cookie = `auth_session=${await seal(sessionOf(Date.now() - 1000), SECRET)}`;
    expect(await getUser(cookie, { env })).toBeNull();

    const middleware = createAuthMiddleware({ env });
    const passed = await middleware(new Request(`${APP}/bots`, { headers: { cookie } }), () => new Response(null));
    expect(passed.headers.getSetCookie().some((entry) => /^auth_session=;/.test(entry))).toBe(true);
  });

  it("живая сессия проходит прослойку без обращения к сервису единого входа", async () => {
    const cookie = `auth_session=${await seal(sessionOf(Date.now() + 60_000), SECRET)}`;
    expect(await getUser(cookie, { env })).toMatchObject({ email: "owner@example.com" });
    const middleware = createAuthMiddleware({ env });
    const passed = await middleware(new Request(`${APP}/bots`, { headers: { cookie } }), () => new Response("next"));
    expect(await passed.text()).toBe("next");
    expect(passed.headers.getSetCookie()).toEqual([]);
  });

  it("cookie, запечатанная другим секретом, — не вход", async () => {
    const cookie = `auth_session=${await seal(sessionOf(Date.now() + 60_000), "other".repeat(10))}`;
    expect(await getUser(cookie, { env })).toBeNull();
  });
});
