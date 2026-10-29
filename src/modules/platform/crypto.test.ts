import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTokenCipher } from "./crypto";

const key = () => randomBytes(32).toString("base64");

describe("шифрование токенов ботов", () => {
  it("расшифровывает то, что зашифровал", () => {
    const cipher = createTokenCipher(key());
    expect(cipher.decrypt(cipher.encrypt("123456:ABC-токен"))).toBe("123456:ABC-токен");
  });

  it("не оставляет токен в открытом виде", () => {
    const cipher = createTokenCipher(key());
    expect(cipher.encrypt("123456:ABC")).not.toContain("123456");
  });

  it("один и тот же токен шифруется каждый раз по-разному", () => {
    const cipher = createTokenCipher(key());
    expect(cipher.encrypt("токен")).not.toBe(cipher.encrypt("токен"));
  });

  it("чужим ключом не расшифровать", () => {
    const encrypted = createTokenCipher(key()).encrypt("токен");
    expect(() => createTokenCipher(key()).decrypt(encrypted)).toThrow();
  });

  it("подмену данных замечает", () => {
    const cipher = createTokenCipher(key());
    const [version, iv, tag, data] = cipher.encrypt("токен").split(":") as [string, string, string, string];
    const flipped = Buffer.from(data, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => cipher.decrypt([version, iv, tag, flipped.toString("base64")].join(":"))).toThrow();
  });

  it("отвергает мусор вместо зашифрованной строки", () => {
    expect(() => createTokenCipher(key()).decrypt("не зашифровано")).toThrow();
  });

  it("требует ключ ровно в 32 байта", () => {
    expect(() => createTokenCipher(randomBytes(16).toString("base64"))).toThrow(/32/);
    expect(() => createTokenCipher("")).toThrow();
  });
});
