import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ requireUser: vi.fn<() => Promise<unknown>>() }));
const roleSwap = vi.hoisted(() => ({
  current: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  start: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  restart: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  submit: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("@/modules/access", () => access);
vi.mock("@/modules/editor", () => ({ getEditorServices: async () => ({ roleSwap }) }));

const { roleSwapState, startRoleSwap, restartRoleSwap, submitRoleSwap } = await import("./role-swap-actions");

const state = { chatId: "chat", status: "active", review: null, finishedReason: null, stageName: null };

beforeEach(() => {
  access.requireUser.mockReset().mockResolvedValue({ id: "expert" });
  roleSwap.current.mockReset().mockResolvedValue(state);
  roleSwap.start.mockReset().mockResolvedValue({ chatId: "chat" });
  roleSwap.restart.mockReset().mockResolvedValue({ chatId: "chat-2" });
  roleSwap.submit.mockReset().mockResolvedValue({ ok: true, recorded: 3, missingComparisons: 0 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("действия «Поменяемся ролями»", () => {
  it("состояние разговора лидмагнита", async () => {
    expect(await roleSwapState("lead")).toEqual(state);
    expect(roleSwap.current).toHaveBeenCalledWith("lead");
  });

  it("старт и «Начать заново» передают «Кто клиент» и отдают чат", async () => {
    expect(await startRoleSwap("lead", "мама школьника")).toEqual({ chatId: "chat" });
    expect(roleSwap.start).toHaveBeenCalledWith("lead", "мама школьника");
    expect(await restartRoleSwap("lead", null)).toEqual({ chatId: "chat-2" });
    expect(roleSwap.restart).toHaveBeenCalledWith("lead", null);
  });

  it("без первого сообщения — отказ со словами, куда идти", async () => {
    roleSwap.start.mockResolvedValue({ error: "no_first_message" });
    const result = await startRoleSwap("lead", null);
    expect(result).toMatchObject({ error: "no_first_message" });
    expect("message" in result && result.message).toContain("первое сообщение");
  });

  it("сбой придумывания клиента — отказ со словами, а не брошенная ошибка", async () => {
    roleSwap.restart.mockRejectedValue(new Error("timeout"));
    const result = await restartRoleSwap("lead", null);
    expect(result).toMatchObject({ error: "failed" });
    expect("message" in result && result.message).toBeTruthy();
  });

  it("«Закончить и разобрать» отдаёт число записей; отказ — со словами для эксперта", async () => {
    expect(await submitRoleSwap("lead")).toEqual({ ok: true, recorded: 3, missingComparisons: 0 });
    expect(roleSwap.submit).toHaveBeenCalledWith("lead");
    for (const error of ["busy", "preparing", "failed", "no_conversation"]) {
      roleSwap.submit.mockResolvedValue({ ok: false, error });
      const result = await submitRoleSwap("lead");
      expect(result).toMatchObject({ ok: false, error });
      expect(!result.ok && result.message).toBeTruthy();
    }
    roleSwap.submit.mockRejectedValue(new Error("база упала"));
    expect(await submitRoleSwap("lead")).toMatchObject({ ok: false, error: "failed" });
  });

  it("без входа эксперта ничего не происходит", async () => {
    access.requireUser.mockRejectedValue(new Error("не вошёл"));
    await expect(roleSwapState("lead")).rejects.toThrow("не вошёл");
    await expect(startRoleSwap("lead", null)).rejects.toThrow("не вошёл");
    await expect(restartRoleSwap("lead", null)).rejects.toThrow("не вошёл");
    await expect(submitRoleSwap("lead")).rejects.toThrow("не вошёл");
    expect(roleSwap.submit).not.toHaveBeenCalled();
    expect(roleSwap.current).not.toHaveBeenCalled();
    expect(roleSwap.start).not.toHaveBeenCalled();
    expect(roleSwap.restart).not.toHaveBeenCalled();
  });
});
