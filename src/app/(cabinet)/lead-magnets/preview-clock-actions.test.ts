import { beforeEach, describe, expect, it, vi } from "vitest";
import { NothingScheduledRefusal, PreviewRefusal } from "@/modules/consultant/preview-flow-test";

const preview = vi.hoisted(() => ({
  nextDay: vi.fn<(...args: unknown[]) => Promise<void>>(),
  advanceBy: vi.fn<(...args: unknown[]) => Promise<number>>(),
  advanceToNextFirstMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("@/modules/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/access")>()),
  requireUser: async () => ({ id: "expert", email: "expert@example.com" }),
}));
vi.mock("@/modules/editor", () => ({ getEditorServices: async () => ({ preview }) }));

const { advancePreviewAction, advancePreviewToReminderAction, nextPreviewDayAction } = await import("./actions");

beforeEach(() => {
  preview.nextDay.mockReset().mockResolvedValue(undefined);
  preview.advanceBy.mockReset().mockResolvedValue(0);
  preview.advanceToNextFirstMessage.mockReset().mockResolvedValue({});
});

describe("промотка «Проверки»", () => {
  it("отказ сервера доходит до эксперта словами: на проде текст брошенной ошибки до браузера не доходит", async () => {
    preview.nextDay.mockRejectedValue(new PreviewRefusal("Это последний день воронки"));
    expect(await nextPreviewDayAction("lead")).toEqual({ error: "Это последний день воронки" });

    preview.advanceBy.mockRejectedValue(new PreviewRefusal("Тестовый разговор завершён: начните проверку заново"));
    expect(await advancePreviewAction("lead", 60_000)).toEqual({ error: "Тестовый разговор завершён: начните проверку заново" });

    preview.advanceToNextFirstMessage.mockRejectedValue(new NothingScheduledRefusal());
    expect(await advancePreviewToReminderAction("lead")).toEqual({ error: new NothingScheduledRefusal().message });
  });

  it("часы сдвинулись — без ошибки", async () => {
    expect(await nextPreviewDayAction("lead", "Europe/Moscow")).toEqual({});
    expect(await advancePreviewAction("lead", 60_000)).toEqual({});
    expect(await advancePreviewToReminderAction("lead")).toEqual({});
  });

  it("настоящий сбой не выдаётся за отказ: эксперт видит общее «Не получилось…»", async () => {
    preview.nextDay.mockRejectedValue(new Error("база недоступна"));
    await expect(nextPreviewDayAction("lead")).rejects.toThrow("база недоступна");
  });
});
