import { describe, expect, it } from "vitest";
import { createLoginAttempts } from "./login-attempts";

const MINUTE = 60_000;

function setup(limits = { windowMs: 15 * MINUTE, perEmailAndIp: 3, perIp: 5, perEmail: 8 }) {
  let now = 1_000_000;
  const attempts = createLoginAttempts({ limits, now: () => now });
  return { attempts, advance: (ms: number) => (now += ms) };
}

describe("ограничение попыток входа", () => {
  it("после нескольких неудач с одного адреса на ту же почту — пауза до конца окна", () => {
    const { attempts, advance } = setup();
    for (let i = 0; i < 3; i++) {
      expect(attempts.retryAfterMs("owner@x.ru", "1.1.1.1")).toBe(0);
      attempts.recordFailure("owner@x.ru", "1.1.1.1");
    }
    expect(attempts.retryAfterMs("owner@x.ru", "1.1.1.1")).toBe(15 * MINUTE);
    advance(10 * MINUTE);
    expect(attempts.retryAfterMs("owner@x.ru", "1.1.1.1")).toBe(5 * MINUTE);
    advance(5 * MINUTE);
    expect(attempts.retryAfterMs("owner@x.ru", "1.1.1.1")).toBe(0);
  });

  it("пауза одного адреса не мешает владельцу войти с другого", () => {
    const { attempts } = setup();
    for (let i = 0; i < 3; i++) attempts.recordFailure("owner@x.ru", "6.6.6.6");
    expect(attempts.retryAfterMs("owner@x.ru", "6.6.6.6")).toBeGreaterThan(0);
    expect(attempts.retryAfterMs("owner@x.ru", "2.2.2.2")).toBe(0);
  });

  it("перебор разных почт с одного адреса тоже упирается в предел", () => {
    const { attempts } = setup();
    for (let i = 0; i < 5; i++) attempts.recordFailure(`user${i}@x.ru`, "6.6.6.6");
    expect(attempts.retryAfterMs("someone-new@x.ru", "6.6.6.6")).toBeGreaterThan(0);
  });

  it("перебор одной почты с множества адресов упирается в общий предел почты", () => {
    const { attempts } = setup();
    for (let i = 0; i < 8; i++) attempts.recordFailure("owner@x.ru", `10.0.0.${i}`);
    expect(attempts.retryAfterMs("owner@x.ru", "10.0.0.200")).toBeGreaterThan(0);
  });

  it("удачный вход сбрасывает счёт неудач этой почты с этого адреса", () => {
    const { attempts } = setup();
    attempts.recordFailure("owner@x.ru", "1.1.1.1");
    attempts.recordFailure("owner@x.ru", "1.1.1.1");
    attempts.recordSuccess("owner@x.ru", "1.1.1.1");
    attempts.recordFailure("owner@x.ru", "1.1.1.1");
    attempts.recordFailure("owner@x.ru", "1.1.1.1");
    expect(attempts.retryAfterMs("owner@x.ru", "1.1.1.1")).toBe(0);
  });
});
