import { describe, expect, it } from "vitest";
import { isStartMessage, startNote } from "./start-note";

describe("служебный старт бота во «Входящих»", () => {
  it("узнаёт старт по коду ссылки и по голой команде", () => {
    expect(isStartMessage({ text: "/start L3OHn3G1", startCode: "L3OHn3G1" })).toBe(true);
    expect(isStartMessage({ text: "/start", startCode: null })).toBe(true);
    expect(isStartMessage({ text: "/startup идея", startCode: null })).toBe(false);
    expect(isStartMessage({ text: "Начнём?", startCode: null })).toBe(false);
  });

  it("называет ссылку с меткой её меткой, а не кодом", () => {
    const labels = new Map([["L3OHn3G1", "Блогер Анна"]]);
    expect(startNote("L3OHn3G1", labels)).toBe("Запуск бота по ссылке «Блогер Анна»");
  });

  it("рекламная метка из ссылки видна как есть", () => {
    expect(startNote("L3OHn3G1__ad_campaign__video_01", new Map())).toBe("Запуск бота по рекламной ссылке «video_01»");
  });

  it("основная ссылка и старт без кода — без кода в тексте", () => {
    expect(startNote("MAINCODE", new Map([["MAINCODE", null]]))).toBe("Запуск бота по ссылке");
    expect(startNote(null, new Map())).toBe("Запуск бота");
  });
});
