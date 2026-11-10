"use client";

import { useEffect, useState } from "react";
import { SegmentedControl } from "@ykurilov/ds-react";
import { THEME_OPTIONS, applyThemePreference, parseThemePreference, readThemePreference, type ThemePreference } from "@/ui/theme-preference";

/** Тема кабинета: автоматически по устройству, светлая или тёмная. Выбор хранит этот браузер. */
export function ThemeSetting() {
  // Сохранённый выбор есть только в браузере: до чтения показываем «Автоматически», затем настоящий выбор
  const [preference, setPreference] = useState<ThemePreference>("auto");
  useEffect(() => { setPreference(readThemePreference()); }, []);
  return <SegmentedControl aria-label="Тема" className="self-start" options={THEME_OPTIONS} value={preference}
    onValueChange={value => { const next = parseThemePreference(value); applyThemePreference(next); setPreference(next); }} />;
}
