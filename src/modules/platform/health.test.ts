import { describe, expect, it } from "vitest";
import { createHealthHandler } from "./health";

const ok = async () => true;
const broken = async () => false;
const throwing = async (): Promise<boolean> => {
  throw new Error("нет связи");
};

async function call(checks: Parameters<typeof createHealthHandler>[0]) {
  const response = await createHealthHandler(checks)();
  return { status: response.status, body: await response.json() };
}

describe("GET /api/health", () => {
  it("200 и {ok, db, queue}, когда база и очередь живы", async () => {
    expect(await call({ checkDatabase: ok, checkQueue: ok })).toEqual({
      status: 200,
      body: { ok: true, db: true, queue: true },
    });
  });

  it("503, если не отвечает база", async () => {
    expect(await call({ checkDatabase: broken, checkQueue: ok })).toEqual({
      status: 503,
      body: { ok: false, db: false, queue: true },
    });
  });

  it("503, если не отвечает очередь", async () => {
    expect(await call({ checkDatabase: ok, checkQueue: broken })).toEqual({
      status: 503,
      body: { ok: false, db: true, queue: false },
    });
  });

  it("исключение в проверке — это «не отвечает», а не падение обработчика", async () => {
    expect(await call({ checkDatabase: throwing, checkQueue: throwing })).toEqual({
      status: 503,
      body: { ok: false, db: false, queue: false },
    });
  });

  it("не кэшируется", async () => {
    const response = await createHealthHandler({ checkDatabase: ok, checkQueue: ok })();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
