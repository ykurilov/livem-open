/** Выбор темы в «Настройках». «Автоматически» — без записи: цвета следуют системной настройке устройства. */
export type ThemePreference = "auto" | "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

export const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: "auto", label: "Автоматически" },
  { value: "light", label: "Светлая" },
  { value: "dark", label: "Тёмная" },
];

export function parseThemePreference(saved: string | null | undefined): ThemePreference {
  return saved === "light" || saved === "dark" ? saved : "auto";
}

export function readThemePreference(): ThemePreference {
  try { return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY)); } catch { return "auto"; }
}

/** Применяет выбор сразу и запоминает его. Без data-theme переменные дизайн-системы сами берут системную тему. */
export function applyThemePreference(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === "auto") delete root.dataset.theme;
  else root.dataset.theme = preference;
  try {
    if (preference === "auto") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch { /* Выбор действует до перезагрузки, даже если хранилище недоступно. */ }
  const background = getComputedStyle(root).getPropertyValue("--yk-bg").trim();
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (preference === "auto") meta.setAttribute("content", meta.getAttribute("data-auto-content") ?? background);
    else meta.setAttribute("content", background);
  }
}

/** Скрипт до гидратации: сохранённую тему ставим сразу, чтобы не мигал чужой фон. */
export function themeInitScript(colors: { light: string; dark: string }): string {
  return `(function () {
  try {
    var saved = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (saved !== "light" && saved !== "dark") return;
    document.documentElement.dataset.theme = saved;
    var color = saved === "dark" ? ${JSON.stringify(colors.dark)} : ${JSON.stringify(colors.light)};
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) { meta.setAttribute("content", color); });
  } catch (e) {}
})();`;
}
