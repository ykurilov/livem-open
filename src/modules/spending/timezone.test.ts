import { createInMemoryChatStorage, SpendingLimitReachedError } from "@ykurilov/agent-chat-core";
import { createSpendingLimits } from "@ykurilov/agent-chat-limits";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../platform/clock";
import { AGENT_TIME_ZONE, DEFAULT_MODEL_CHOICE, createAppCatalog } from "../platform/models-catalog";

async function setup(start: string) {
  const storage = createInMemoryChatStorage();
  const clock = createFakeClock(new Date(start));
  const limits = createSpendingLimits({
    storage,
    catalog: createAppCatalog({}),
    budget: () => ({ user: 1 }),
    period: "day",
    timeZone: AGENT_TIME_ZONE,
    now: () => clock.now(),
  });
  await storage.insertUsageRecord({
    id: "r1",
    ownerId: "anna",
    chatId: "chat-1",
    messageId: null,
    source: "answer",
    ...DEFAULT_MODEL_CHOICE,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 1.5,
    createdAt: "2026-10-03T12:00:00.000Z",
  });
  return { limits, clock };
}

const check = (limits: Awaited<ReturnType<typeof setup>>["limits"]) =>
  limits.assertWithinLimit({ userId: "anna", chatId: "chat-1" });

describe("дневной лимит по московским суткам", () => {
  it("лимит исчерпан в 23:59 по Москве", async () => {
    const { limits, clock } = await setup("2026-10-03T20:59:00Z");
    await expect(check(limits)).rejects.toBeInstanceOf(SpendingLimitReachedError);
    clock.advance(30_000);
    await expect(check(limits)).rejects.toBeInstanceOf(SpendingLimitReachedError);
  });

  it("в 00:00 по Москве (21:00 UTC) лимит обнуляется", async () => {
    const { limits, clock } = await setup("2026-10-03T20:59:59Z");
    await expect(check(limits)).rejects.toBeInstanceOf(SpendingLimitReachedError);
    clock.advance(1000); // 21:00:00 UTC = 00:00 МСК
    await expect(check(limits)).resolves.toBeUndefined();
  });

  it("сообщает московскую границу сброса", async () => {
    const { limits } = await setup("2026-10-03T12:00:00Z");
    const error = await check(limits).catch((failure) => failure as SpendingLimitReachedError);
    expect(error).toBeInstanceOf(SpendingLimitReachedError);
    expect((error as SpendingLimitReachedError).timeZone).toBe("Europe/Moscow");
    expect(new Date((error as SpendingLimitReachedError).resetsAt!).toISOString()).toBe("2026-10-03T21:00:00.000Z");
  });
});

describe("когда продолжить после лимита", () => {
  it("UTC+12: сброс в полночь по Москве — ровно 9:00 там, продолжаем в этот же момент, а не через сутки", async () => {
    const { morningAfter } = await import("./daily-limit");
    const clock = createFakeClock(new Date("2026-10-03T12:00:00Z"));
    const reset = "2026-10-03T21:00:00.000Z";
    const at = await morningAfter({ db: null as never, clock }, reset, { morningAt: "09:00", timeZone: "Asia/Kamchatka" });
    expect(at.toISOString()).toBe(reset);
    const moscow = await morningAfter({ db: null as never, clock }, reset, { morningAt: "09:00", timeZone: "Europe/Moscow" });
    expect(moscow.toISOString()).toBe("2026-10-04T06:00:00.000Z");
  });
});
