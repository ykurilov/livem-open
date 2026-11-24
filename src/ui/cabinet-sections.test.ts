import { describe, expect, it } from "vitest";
import { CABINET_SECTIONS, PEOPLE_TABS, SETTINGS_SECTION, activeTabHref, isSectionActive } from "./cabinet-sections";

const section = (href: string) => CABINET_SECTIONS.find((candidate) => candidate.href === href)!;

describe("боковое меню кабинета", () => {
  it("разделы идут в согласованном порядке", () => {
    expect(CABINET_SECTIONS.map((candidate) => candidate.title)).toEqual([
      "Лидмагниты",
      "Входящие",
      "Люди",
      "Созвоны",
      "Рассылки",
      "База знаний",
    ]);
  });

  it("пункт подсвечен на любой своей вкладке", () => {
    expect(isSectionActive(section("/people"), "/fields")).toBe(true);
    expect(isSectionActive(section("/knowledge"), "/images")).toBe(true);
    expect(isSectionActive(section("/knowledge"), "/videos")).toBe(true);
    expect(isSectionActive(SETTINGS_SECTION, "/bots")).toBe(true);
    expect(isSectionActive(section("/calls"), "/call-bookings")).toBe(true);
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

describe("вкладка раздела по адресу", () => {
  it("вложенная вкладка точнее родительской; карточка человека — под «Списком»", () => {
    expect(activeTabHref(PEOPLE_TABS, "/people/sources")).toBe("/people/sources");
    expect(activeTabHref(PEOPLE_TABS, "/people")).toBe("/people");
    expect(activeTabHref(PEOPLE_TABS, "/people/6f1c2b9e-1d3a-4c5b-8e7f-0a1b2c3d4e5f")).toBe("/people");
    expect(activeTabHref(PEOPLE_TABS, "/fields")).toBe("/fields");
  });
});
