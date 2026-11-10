import { describe, expect, it } from "vitest";
import { recipientsPhrase } from "./recipients-phrase";

describe("recipientsPhrase — число получателей словами у кнопки «Отправить сейчас»", () => {
  it("никого — так и говорит", () => expect(recipientsPhrase(0)).toBe("Получателей нет"));
  it("один и 21 — «человеку»", () => {
    expect(recipientsPhrase(1)).toBe("Уйдёт 1 человеку");
    expect(recipientsPhrase(21)).toBe("Уйдёт 21 человеку");
  });
  it("остальные — «людям», включая 11", () => {
    expect(recipientsPhrase(2)).toBe("Уйдёт 2 людям");
    expect(recipientsPhrase(11)).toBe("Уйдёт 11 людям");
    expect(recipientsPhrase(1250)).toBe("Уйдёт 1250 людям");
  });
});
