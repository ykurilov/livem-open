import { describe, expect, it } from "vitest";
import { parseSiteList, siteAllowed } from "./allowed-sites";

describe("список разрешённых сайтов", () => {
  it("принимает домен в любом виде: с адресом страницы, портом, заглавными — остаётся домен", () => {
    expect(parseSiteList("https://Example.ru/courses?utm=1\nshop.example.ru:8080, www.example.ru")).toEqual({
      sites: ["example.ru", "shop.example.ru", "www.example.ru"],
      invalid: [],
    });
  });

  it("маска поддоменов остаётся маской, повторы и пустые строки убираются", () => {
    expect(parseSiteList("*.example.ru\n\n*.EXAMPLE.ru\nexample.ru\nexample.ru")).toEqual({
      sites: ["*.example.ru", "example.ru"],
      invalid: [],
    });
  });

  it("русский домен — в том виде, в каком его шлёт браузер", () => {
    expect(parseSiteList("школа.рф").sites).toEqual(["xn--80atdl2c.xn--p1ai"]);
  });

  it("не домен и слишком широкая маска — в непринятых, как их написали", () => {
    expect(parseSiteList("не домен\n*\n*.ru\nexa_mple..ru\n*.example.ru")).toEqual({
      sites: ["*.example.ru"],
      invalid: ["не домен", "*", "*.ru", "exa_mple..ru"],
    });
  });
});

describe("сверка сайта посетителя", () => {
  it("пустой список — виджет работает везде", () => {
    expect(siteAllowed([], "https://any.site")).toBe(true);
    expect(siteAllowed([], null)).toBe(true);
  });

  it("домен из списка — да, другой — нет; протокол и порт не важны", () => {
    const sites = ["example.ru"];
    expect(siteAllowed(sites, "https://example.ru")).toBe(true);
    expect(siteAllowed(sites, "http://example.ru:8080")).toBe(true);
    expect(siteAllowed(sites, "https://shop.example.ru")).toBe(false);
    expect(siteAllowed(sites, "https://example.ru.evil.com")).toBe(false);
    expect(siteAllowed(sites, "https://notexample.ru")).toBe(false);
  });

  it("маска — любой поддомен, но не сам домен", () => {
    const sites = ["*.example.ru"];
    expect(siteAllowed(sites, "https://shop.example.ru")).toBe(true);
    expect(siteAllowed(sites, "https://a.b.example.ru")).toBe(true);
    expect(siteAllowed(sites, "https://example.ru")).toBe(false);
    expect(siteAllowed(sites, "https://badexample.ru")).toBe(false);
  });

  it("список не пустой, а сайт не назвался (нет Origin или «null») — нет", () => {
    expect(siteAllowed(["example.ru"], null)).toBe(false);
    expect(siteAllowed(["example.ru"], "null")).toBe(false);
    expect(siteAllowed(["example.ru"], "не адрес")).toBe(false);
  });

  it("русский домен из списка узнаётся в адресе браузера", () => {
    expect(siteAllowed(parseSiteList("школа.рф").sites, "https://xn--80atdl2c.xn--p1ai")).toBe(true);
  });
});
