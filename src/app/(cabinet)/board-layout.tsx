"use client";

import { createContext, useContext, useLayoutEffect } from "react";

/** Что рабочая область просит у каркаса кабинета, пока на экране широкая доска. */
export const BoardLayoutContext = createContext<(active: boolean) => void>(() => {});

/**
 * Пока `active`, кабинет убирает внутренние отступы рабочей области для доски.
 * Навигация «Студии» сохраняет одинаковую ширину на всех экранах.
 * Отступы меняются до отрисовки: иначе доска успевает один раз подогнать граф под окно
 * со старыми полями и остаётся смещённой, когда поля исчезают.
 */
export function useBoardLayout(active: boolean) {
  const setActive = useContext(BoardLayoutContext);
  useLayoutEffect(() => {
    setActive(active);
    return () => setActive(false);
  }, [active, setActive]);
}
