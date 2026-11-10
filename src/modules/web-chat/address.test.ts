import { describe, expect, it } from "vitest";
import { clientAddress } from "./address";

describe("адрес посетителя веб-чата", () => {
  it("за nginx — X-Real-IP, подставленное начало X-Forwarded-For не помогает", () => {
    const headers = new Headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "1.1.1.1, 203.0.113.7" });
    expect(clientAddress(headers)).toBe("203.0.113.7");
  });

  it("без X-Real-IP — последний адрес X-Forwarded-For: его дописал ближайший прокси", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("без заголовков — общий «unknown»", () => {
    expect(clientAddress(new Headers())).toBe("unknown");
  });
});
