export interface RateLimiter {
  /** Возвращается, когда боту можно отправлять следующее сообщение: не чаще `ratePerSecond` в секунду. */
  acquire(botId: string, ratePerSecond: number): Promise<void>;
}

export interface RateLimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Ограничитель скорости по ботам внутри одного процесса. Каждый вызов занимает своё место в очереди. */
export function createRateLimiter(clock: RateLimiterClock): RateLimiter {
  const nextAllowedAt = new Map<string, number>();
  return {
    async acquire(botId, ratePerSecond) {
      const intervalMs = 1000 / ratePerSecond;
      const now = clock.now();
      const slot = Math.max(now, nextAllowedAt.get(botId) ?? now);
      // место занимается до первого await, поэтому одновременные вызовы не получают одно и то же время
      nextAllowedAt.set(botId, slot + intervalMs);
      const wait = slot - now;
      if (wait > 0) await clock.sleep(wait);
    },
  };
}
