import { describe, expect, it } from "vitest";
import { CABINET_SECTIONS, isSectionActive } from "./cabinet-sections";

const section = (href: string) => CABINET_SECTIONS.find((candidate) => candidate.href === href)!;

describe("боковое меню кабинета", () => {
  it("разделы идут в согласованном порядке", () => {
    expect(CABINET_SECTIONS.map((candidate) => candidate.title)).toEqual([
      "Лидмагниты",
      "Боты",
      "База",
      "Поля базы",
      "Видео",
      "Картинки",
      "Рассылки",
      "Входящие",
      "Настройки",
    ]);
  });

  it("редактор лидмагнита подсвечивает «Лидмагниты»", () => {
    expect(isSectionActive(section("/"), "/lead-magnets/abc/publish")).toBe(true);
    expect(isSectionActive(section("/"), "/bots")).toBe(false);
  });

  it("вложенные экраны подсвечивают свой раздел", () => {
    expect(isSectionActive(section("/people"), "/people/42")).toBe(true);
    expect(isSectionActive(section("/mailings"), "/mailings/new")).toBe(true);
  });

  it("похожий по началу путь не считается тем же разделом", () => {
    expect(isSectionActive(section("/people"), "/people-extra")).toBe(false);
  });
});
