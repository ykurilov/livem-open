import { describe, expect, it } from "vitest";
import { CABINET_SECTIONS, SETTINGS_SECTION, isSectionActive } from "./cabinet-sections";

const section = (href: string) => CABINET_SECTIONS.find((candidate) => candidate.href === href)!;

describe("боковое меню кабинета", () => {
  it("разделы идут в согласованном порядке", () => {
    expect(CABINET_SECTIONS.map((candidate) => candidate.title)).toEqual([
      "Лидмагниты",
      "Входящие",
      "Люди",
      "Рассылки",
      "База знаний",
      "Настройки",
    ]);
  });

  it("пункт подсвечен на любой своей вкладке", () => {
    expect(isSectionActive(section("/people"), "/fields")).toBe(true);
    expect(isSectionActive(section("/knowledge"), "/images")).toBe(true);
    expect(isSectionActive(section("/knowledge"), "/videos")).toBe(true);
    expect(isSectionActive(SETTINGS_SECTION, "/bots")).toBe(true);
    expect(isSectionActive(SETTINGS_SECTION, "/people")).toBe(false);
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
