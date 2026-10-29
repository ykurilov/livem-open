import { describe, expect, it } from "vitest";
import { decideAccess, isEmailAllowed, isPublicPath, parseAllowedEmails } from "./access";

const allowed = parseAllowedEmails("Expert@Example.com, second@example.com");

describe("список разрешённых адресов", () => {
  it("читает адреса через запятую, пробел, точку с запятой и перенос строки, без учёта регистра", () => {
    expect([...parseAllowedEmails(" A@x.ru;b@x.ru\nC@X.ru  d@x.ru,, ")].sort()).toEqual([
      "a@x.ru",
      "b@x.ru",
      "c@x.ru",
      "d@x.ru",
    ]);
  });

  it("пустая или незаданная настройка — не пускает никого", () => {
    expect(parseAllowedEmails(undefined).size).toBe(0);
    expect(isEmailAllowed("expert@example.com", parseAllowedEmails(""))).toBe(false);
  });

  it("адрес сверяется без учёта регистра", () => {
    expect(isEmailAllowed("EXPERT@example.COM", allowed)).toBe(true);
    expect(isEmailAllowed("stranger@example.com", allowed)).toBe(false);
  });

  it("у пользователя нет адреса — не пускаем", () => {
    expect(isEmailAllowed(undefined, allowed)).toBe(false);
  });
});

describe("открытые адреса", () => {
  it.each(["/api/health", "/api/auth/login", "/api/auth/silent", "/api/auth/callback", "/login", "/api/webhooks/telegram/abc", "/api/integrations/getcourse/secret", "/i/K7mP2xQ"])(
    "%s открыт без входа",
    (pathname) => expect(isPublicPath(pathname)).toBe(true),
  );

  it.each(["/", "/magnets", "/bots/1", "/api/constructor", "/api/images/image-1.png", "/api/healthcheck", "/login-help", "/ii", "/info"])(
    "%s закрыт",
    (pathname) => expect(isPublicPath(pathname)).toBe(false),
  );
});

describe("решение о доступе", () => {
  const base = { search: "", allowedEmails: allowed, silentCheckDone: false };

  it("открытый адрес пропускаем без входа", () => {
    expect(decideAccess({ ...base, pathname: "/api/health", user: null })).toEqual({ kind: "allow" });
  });

  it("разрешённый пользователь проходит", () => {
    expect(decideAccess({ ...base, pathname: "/bots", user: { email: "expert@example.com" } })).toEqual({
      kind: "allow",
    });
  });

  it("страница без входа: сначала тихая проверка единого входа, и возврат на ту же страницу", () => {
    expect(decideAccess({ ...base, pathname: "/bots", search: "?tab=1", user: null })).toEqual({
      kind: "redirect",
      to: "/api/auth/silent?next=%2Fbots%3Ftab%3D1",
    });
  });

  it("тихая проверка уже была — показываем экран «Войти», а не гоняем по кругу", () => {
    expect(decideAccess({ ...base, silentCheckDone: true, pathname: "/bots", user: null })).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fbots",
    });
  });

  it("запрос к API без входа — 401, без перенаправлений", () => {
    expect(decideAccess({ ...base, pathname: "/api/constructor", user: null })).toEqual({ kind: "reject", status: 401 });
  });

  it("вошедший, но не из списка: страница ведёт на экран с отказом", () => {
    expect(decideAccess({ ...base, pathname: "/bots", user: { email: "stranger@example.com" } })).toEqual({
      kind: "redirect",
      to: "/login?error=access_denied",
    });
  });

  it("вошедший, но не из списка: API отвечает 403", () => {
    expect(decideAccess({ ...base, pathname: "/api/constructor", user: { email: "stranger@example.com" } })).toEqual({
      kind: "reject",
      status: 403,
    });
  });
});
