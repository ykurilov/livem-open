import { describe, expect, it } from "vitest";
import { parseThemePreference, themeInitScript } from "./theme-preference";

describe("выбор темы", () => {
  it("без сохранённого выбора тема автоматическая", () => {
    expect(parseThemePreference(null)).toBe("auto");
    expect(parseThemePreference("system")).toBe("auto");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
  });

  it("скрипт до гидратации ставит только сохранённую тему, иначе оставляет системную", () => {
    const run = (saved: string | null) => {
      const metas = [{ content: "", setAttribute(_: string, value: string) { this.content = value; } }];
      const root = { dataset: {} as Record<string, string> };
      new Function("localStorage", "document", themeInitScript({ light: "#fff", dark: "#000" }))(
        { getItem: () => saved },
        { documentElement: root, querySelectorAll: () => metas },
      );
      return { theme: root.dataset.theme, color: metas[0]!.content };
    };
    expect(run(null)).toEqual({ theme: undefined, color: "" });
    expect(run("dark")).toEqual({ theme: "dark", color: "#000" });
    expect(run("light")).toEqual({ theme: "light", color: "#fff" });
  });
});
