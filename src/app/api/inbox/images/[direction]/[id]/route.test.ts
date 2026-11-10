import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ status: null as 401 | 403 | null }));
const inboxImageResponse = vi.hoisted(() => vi.fn(async () => new Response("png")));

vi.mock("@/modules/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/access")>();
  return {
    ...actual,
    requireUser: async () => {
      if (access.status) throw new actual.AccessError(access.status);
      return { id: "expert", email: "expert@example.com" };
    },
  };
});
vi.mock("@/modules/inbox", () => ({ inboxImageFilesFromEnv: () => ({}), inboxImageResponse }));
vi.mock("@/modules/platform/db", () => ({ getDatabase: () => ({ db: {} }) }));

const { GET } = await import("./route");
const get = (direction: string, id: string) => GET(new Request("http://localhost"), { params: Promise.resolve({ direction, id }) });

beforeEach(() => {
  inboxImageResponse.mockClear();
});

describe("адрес показа картинки «Входящих»", () => {
  it("без входа — 401, без доступа к кабинету — 403, картинку не ищет", async () => {
    access.status = 401;
    expect((await get("in", randomUUID())).status).toBe(401);
    access.status = 403;
    expect((await get("out", randomUUID())).status).toBe(403);
    expect(inboxImageResponse).not.toHaveBeenCalled();
  });

  it("вошедшему — картинка по сообщению", async () => {
    access.status = null;
    const id = randomUUID();
    expect((await get("in", id)).status).toBe(200);
    expect(inboxImageResponse).toHaveBeenCalledWith({}, {}, "in", id);
  });
});
