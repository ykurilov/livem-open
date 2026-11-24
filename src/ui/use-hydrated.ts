"use client";
import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** `false`, пока страница не ожила: кнопки с обработчиком нажатия до этого молча не срабатывают — их стоит выключать. */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
