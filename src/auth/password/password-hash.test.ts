import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password-hash";

describe("хеш пароля", () => {
  it("хеш не содержит самого пароля и у одного пароля каждый раз свой", async () => {
    const first = await hashPassword("правильная лошадь батарейка");
    const second = await hashPassword("правильная лошадь батарейка");
    expect(first).not.toContain("лошадь");
    expect(first).not.toBe(second);
    expect(first.startsWith("scrypt$")).toBe(true);
  });

  it("верный пароль подходит, неверный — нет", async () => {
    const stored = await hashPassword("correct-horse-battery");
    expect(await verifyPassword("correct-horse-battery", stored)).toBe(true);
    expect(await verifyPassword("correct-horse-batterY", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("испорченный или чужой формат хеша — просто «не подходит», без ошибки", async () => {
    for (const broken of ["", "plain-text", "scrypt$1$2$3$x$y", "bcrypt$2b$10$abc", "scrypt$99999999999$8$1$c2FsdA$aGFzaA"]) {
      expect(await verifyPassword("anything", broken)).toBe(false);
    }
  });
});
