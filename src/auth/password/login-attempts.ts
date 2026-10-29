// Ограничение частоты неудачных попыток входа. Счёт в памяти процесса: веб-сервер у установки один.
// Три счётчика за скользящее окно:
//   почта + адрес — обычный подбор пароля с одного компьютера;
//   адрес         — перебор разных почт с одного компьютера;
//   почта         — подбор одной почты с множества адресов (предел выше, чтобы чужие попытки
//                   не запирали владельца надолго).
export interface LoginAttemptLimits {
  windowMs: number;
  perEmailAndIp: number;
  perIp: number;
  perEmail: number;
}

export const DEFAULT_LOGIN_LIMITS: LoginAttemptLimits = {
  windowMs: 15 * 60_000,
  perEmailAndIp: 5,
  perIp: 20,
  perEmail: 50,
};

// Сколько ключей держим до уборки устаревших.
const SWEEP_THRESHOLD = 10_000;

export interface LoginAttempts {
  /** Через сколько миллисекунд можно пробовать снова; 0 — можно сейчас. */
  retryAfterMs(email: string, ip: string): number;
  recordFailure(email: string, ip: string): void;
  recordSuccess(email: string, ip: string): void;
}

export function createLoginAttempts(
  options: { limits?: LoginAttemptLimits; now?: () => number } = {},
): LoginAttempts {
  const limits = options.limits ?? DEFAULT_LOGIN_LIMITS;
  const now = options.now ?? Date.now;
  const failures = new Map<string, number[]>();

  const counters = (email: string, ip: string): Array<[string, number]> => [
    [`pair:${email}|${ip}`, limits.perEmailAndIp],
    [`ip:${ip}`, limits.perIp],
    [`email:${email}`, limits.perEmail],
  ];

  function recent(key: string, at: number): number[] {
    const kept = (failures.get(key) ?? []).filter((time) => time > at - limits.windowMs);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  }

  function sweep(at: number): void {
    if (failures.size < SWEEP_THRESHOLD) return;
    for (const key of [...failures.keys()]) recent(key, at);
  }

  return {
    retryAfterMs(email, ip) {
      const at = now();
      let wait = 0;
      for (const [key, limit] of counters(email, ip)) {
        const times = recent(key, at);
        // Счёт опустится ниже предела, когда из окна выйдет неудача номер (length - limit)
        if (times.length >= limit) wait = Math.max(wait, times[times.length - limit]! + limits.windowMs - at);
      }
      return wait;
    },
    recordFailure(email, ip) {
      const at = now();
      sweep(at);
      for (const [key] of counters(email, ip)) failures.set(key, [...recent(key, at), at]);
    },
    recordSuccess(email, ip) {
      failures.delete(`pair:${email}|${ip}`);
    },
  };
}
