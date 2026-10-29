import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limiter";

function createHarness(start = 1_000_000) {
  let current = start;
  const sleeps: number[] = [];
  const limiter = createRateLimiter({
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms);
      await Promise.resolve(); // время идёт только пока ждём, как и в жизни
      current += ms;
    },
  });
  return { limiter, sleeps, advance: (ms: number) => (current += ms) };
}

describe("ограничение скорости по боту", () => {
  it("первое сообщение уходит сразу", async () => {
    const { limiter, sleeps } = createHarness();
    await limiter.acquire("bot-1", 2);
    expect(sleeps).toEqual([]);
  });

  it("при 2 сообщениях в секунду второе ждёт полсекунды", async () => {
    const { limiter, sleeps } = createHarness();
    await limiter.acquire("bot-1", 2);
    await limiter.acquire("bot-1", 2);
    expect(sleeps).toEqual([500]);
  });

  it("если пауза уже прошла сама, ждать не надо", async () => {
    const { limiter, sleeps, advance } = createHarness();
    await limiter.acquire("bot-1", 2);
    advance(700);
    await limiter.acquire("bot-1", 2);
    expect(sleeps).toEqual([]);
  });

  it("у разных ботов скорость считается отдельно", async () => {
    const { limiter, sleeps } = createHarness();
    await limiter.acquire("bot-1", 1);
    await limiter.acquire("bot-2", 1);
    expect(sleeps).toEqual([]);
  });

  it("одновременные запросы встают в очередь, а не проходят разом", async () => {
    const { limiter, sleeps } = createHarness();
    await Promise.all([limiter.acquire("bot-1", 4), limiter.acquire("bot-1", 4), limiter.acquire("bot-1", 4)]);
    expect(sleeps.sort((a, b) => a - b)).toEqual([250, 500]);
  });
});
