import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ requireUser: vi.fn<() => Promise<unknown>>() }));
const corrections = vi.hoisted(() => ({ countPending: vi.fn<(...args: unknown[]) => Promise<number>>() }));

vi.mock("@/modules/access", () => access);
vi.mock("@/modules/corrections", () => corrections);
vi.mock("@/modules/platform/db", () => ({ getDatabase: () => ({ db: "db" }) }));

const { pendingCorrectionsCount } = await import("./corrections-actions");

beforeEach(() => {
  access.requireUser.mockReset().mockResolvedValue({ id: "expert" });
  corrections.countPending.mockReset().mockResolvedValue(2);
});

describe("число неразобранных правок", () => {
  it("отдаёт число неразобранных правок лидмагнита", async () => {
    expect(await pendingCorrectionsCount("lead")).toBe(2);
    expect(corrections.countPending).toHaveBeenCalledWith("db", "lead");
  });

  it("без входа эксперта числа нет", async () => {
    access.requireUser.mockRejectedValue(new Error("не вошёл"));
    await expect(pendingCorrectionsCount("lead")).rejects.toThrow("не вошёл");
    expect(corrections.countPending).not.toHaveBeenCalled();
  });
});
