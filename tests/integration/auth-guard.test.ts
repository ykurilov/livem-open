import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AccessError, isPublicPath } from "@/modules/access";
import { createTestDatabase, type TestDatabase } from "./db-helper";

// Кто «пришёл» в этом тесте: кука задаёт, вошёл ли человек и с каким адресом
const OWNER_COOKIE = "who=owner";
const STRANGER_COOKIE = "who=stranger";
const ANONYMOUS_COOKIE = "who=nobody";
const USERS: Record<string, { id: string; email: string } | undefined> = {
  [OWNER_COOKIE]: { id: "owner-1", email: "Owner@Example.com" },
  [STRANGER_COOKIE]: { id: "stranger-1", email: "stranger@example.com" },
};
let currentCookie = ANONYMOUS_COOKIE;

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: currentCookie }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/auth", () => ({
  getUser: async (cookieHeader: string | null) => USERS[cookieHeader ?? ""] ?? null,
  createAuthMiddleware: () => async (_request: unknown, next: () => Response) => next(),
}));

const SRC = join(process.cwd(), "src");
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

const sourceFiles = walk(join(SRC, "app")).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));

/** Файлы с директивой "use server" в первой строке кода. */
const serverActionFiles = sourceFiles.filter((file) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(readFileSync(file, "utf8")));
const routeFiles = sourceFiles.filter((file) => /[\\/]route\.ts$/.test(file));

const apiPath = (file: string) =>
  "/" +
  relative(join(SRC, "app"), file)
    .split(sep)
    .slice(0, -1)
    .filter((part) => !part.startsWith("("))
    .map((part) => part.replace(/^\[\.\.\.(.+)\]$/, "$1-x").replace(/^\[(.+)\]$/, "$1-x"))
    .join("/");

const closedRoutes = routeFiles.filter((file) => !isPublicPath(apiPath(file)));
const openRoutes = routeFiles.filter((file) => isPublicPath(apiPath(file)));

const label = (file: string) => relative(SRC, file).split(sep).join("/");

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  process.env.DATABASE_URL = database.url;
  process.env.ALLOWED_EMAILS = "owner@example.com";
  process.env.STUB_MODEL = "scripted";
});

afterAll(async () => {
  const shared = globalThis as { livemDatabase?: { close(): Promise<void> }; livemChatStorage?: Promise<{ close?(): Promise<void> }> };
  await shared.livemDatabase?.close();
  await (await shared.livemChatStorage)?.close?.();
  await database.drop();
});

describe("перебор нашёл что проверять", () => {
  it("видит server actions кабинета и обработчики API", () => {
    expect(serverActionFiles.map(label)).toEqual(expect.arrayContaining(["app/(cabinet)/bots/actions.ts", "app/(cabinet)/settings/actions.ts"]));
    expect(closedRoutes.map((file) => apiPath(file))).toEqual(expect.arrayContaining(["/api/constructor/path-x", "/api/preview/path-x"]));
    expect(openRoutes.map((file) => apiPath(file))).toEqual(
      expect.arrayContaining(["/api/health", "/api/webhooks/channel-x/botId-x"]),
    );
  });
});

describe.each(serverActionFiles.map((file) => [label(file), file] as const))("server actions: %s", (_name, file) => {
  it.each([
    ["без входа", ANONYMOUS_COOKIE, 401],
    ["с адресом не из ALLOWED_EMAILS", STRANGER_COOKIE, 403],
  ] as const)("каждое действие отклоняется %s", async (_case, cookie, status) => {
    currentCookie = cookie;
    const module = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    const exported = Object.entries(module);
    expect(exported.length).toBeGreaterThan(0);

    for (const [name, action] of exported) {
      expect(typeof action, `${name} должен быть функцией`).toBe("function");
      const outcome = await Promise.resolve()
        .then(() => (action as (...args: unknown[]) => unknown)(...Array(6).fill(new FormData())))
        .then(
          () => "выполнилось",
          (error: unknown) => error,
        );
      expect(outcome, `${name} выполнился без проверки доступа`).toBeInstanceOf(AccessError);
      expect((outcome as AccessError).status, name).toBe(status);
    }
  });
});

describe.each(closedRoutes.map((file) => [apiPath(file), file] as const))("обработчик кабинета %s", (path, file) => {
  const call = async (method: string, cookie: string) => {
    currentCookie = cookie;
    const module = (await import(/* @vite-ignore */ file)) as Record<string, (request: Request) => Promise<Response>>;
    return module[method]!(
      new Request(`http://localhost${path}`, { method, headers: { cookie }, ...(method !== "GET" && method !== "HEAD" ? { body: "{}" } : {}) }),
    );
  };

  it.each([
    ["без входа", ANONYMOUS_COOKIE],
    ["с адресом не из ALLOWED_EMAILS", STRANGER_COOKIE],
  ] as const)("все методы отклоняются %s", async (_case, cookie) => {
    const module = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    const methods = HTTP_METHODS.filter((method) => method in module);
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      const response = await call(method, cookie);
      expect([401, 403], `${method} ${path}: ${response.status}`).toContain(response.status);
    }
  });
});

describe("прокси: закрытые адреса", () => {
  it.each(closedRoutes.map((file) => [apiPath(file)] as const))("%s: 401 без входа, 403 чужому адресу, пропуск владельцу", async (path) => {
    const { proxy } = await import("@/proxy");
    const request = (cookie: string) => {
      return new NextRequest(`http://localhost${path}`, { headers: { cookie } });
    };
    expect((await proxy(request(ANONYMOUS_COOKIE))).status).toBe(401);
    expect((await proxy(request(STRANGER_COOKIE))).status).toBe(403);
    expect((await proxy(request(OWNER_COOKIE))).status).toBe(200);
  });
});

describe("открытые адреса", () => {
  it.each(openRoutes.map((file) => [apiPath(file)] as const))("прокси пропускает %s без входа", async (path) => {
    const { proxy } = await import("@/proxy");
    const response = await proxy(new NextRequest(`http://localhost${path}`, { headers: { cookie: ANONYMOUS_COOKIE } }));
    expect(response.status).toBe(200);
  });
});
