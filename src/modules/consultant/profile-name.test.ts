import { describe, expect, it } from "vitest";
import { NAME_REST_ANSWERS, namedRecently } from "./profile-name";

describe("имя в последних ответах консультанта", () => {
  it("имя в прошлом ответе — в этом по имени не называть", () => {
    expect(namedRecently("Ольга", ["Ура, Ольга! Получилось."])).toBe(true);
  });

  it("другие падежи и регистр — тоже имя", () => {
    expect(namedRecently("Ольга", ["Для ольги подготовил запрос."])).toBe(true);
    expect(namedRecently("Света", ["Спасибо, Свет, за отзыв"])).toBe(true);
  });

  it(`имя было раньше ${NAME_REST_ANSWERS} последних ответов — можно`, () => {
    expect(namedRecently("Ольга", ["Ольга, привет", "Дальше шаг", "Нажмите «Собрать»", "Готово"].slice(-NAME_REST_ANSWERS))).toBe(false);
  });

  it("часть другого слова — не имя", () => {
    expect(namedRecently("Ян", ["Январь подходит?", "Отлично, это ясно"])).toBe(false);
  });

  it("имени нет — правила нет", () => {
    expect(namedRecently("", ["Ольга"])).toBe(false);
  });
});
