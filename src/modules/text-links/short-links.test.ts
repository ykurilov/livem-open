import { describe, expect, it } from "vitest";
import { isShortCode, newShortCode, shortLinkResponse, SHORT_CODE_ALPHABET } from "./short-links";

const template = "https://appstudio.example.com/?idea={text}&type={type}";
const target = "https://appstudio.example.com/?idea=%D0%9A%D0%BE%D1%82&type=game";
const known = (row: { target: string; template: string } | null) => ({
  lookup: async () => row,
  services: async () => ["https://appstudio.example.com/"],
});

describe("короткая ссылка: код", () => {
  it("код — 7 знаков латиницы и цифр без похожих (0 O o 1 l I i)", () => {
    for (let i = 0; i < 200; i++) {
      const code = newShortCode();
      expect(code).toMatch(/^[A-Za-z0-9]{7}$/);
      expect(code).not.toMatch(/[0Oo1lIi]/);
      expect(isShortCode(code)).toBe(true);
    }
    expect(SHORT_CODE_ALPHABET).not.toMatch(/[0Oo1lIi]/);
  });

  it("плохой код: короче 6, длиннее 8, чужие знаки — не код", () => {
    for (const code of ["abc", "abcdefghj", "K7mP2x!", "K7mP2xO", "../etc", "", "К7mP2xQ"]) expect(isShortCode(code), code).toBe(false);
  });
});

describe("GET /i/<код>", () => {
  it("известный код — 302 на полную ссылку", async () => {
    expect(await shortLinkResponse("K7mP2xQ", known({ target, template }))).toEqual({ status: 302, location: target });
  });

  it("неизвестный код — страница «Ссылка устарела» со ссылкой на сервис, не 500", async () => {
    const response = await shortLinkResponse("K7mP2xQ", known(null));
    expect(response.status).toBe(200);
    if (!("html" in response)) throw new Error("ждали страницу");
    expect(response.html).toContain("Ссылка устарела");
    expect(response.html).toContain('href="https://appstudio.example.com/"');
  });

  it("плохой код — 404 без обращения к базе", async () => {
    let asked = false;
    const deps = { lookup: async () => ((asked = true), null), services: async () => [] };
    expect((await shortLinkResponse("../../evil", deps)).status).toBe(404);
    expect(asked).toBe(false);
  });

  it("нет открытого перенаправления: только адрес, собранный шаблоном — тот же сайт и путь, параметры шаблона, https", async () => {
    for (const bad of [
      "https://evil.com/?idea=x",
      "http://appstudio.example.com/?idea=x",
      "https://appstudio.example.com@evil.com/?idea=x",
      "https://appstudio.example.com/other?idea=x",
      "https://appstudio.example.com/?idea=x&next=https://evil.com",
      "javascript:alert(1)",
    ]) {
      const response = await shortLinkResponse("K7mP2xQ", known({ target: bad, template }));
      expect(response.status, bad).toBe(200);
      expect("location" in response, bad).toBe(false);
    }
  });
});
