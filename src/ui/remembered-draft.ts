"use client";

import { useCallback, useEffect, useState, type SetStateAction } from "react";

/**
 * Набранный текст, который переживает уход со страницы и перезагрузку: лежит в браузере под `storageKey`, пока его не
 * отправят или не сотрут. Пустой текст убирает запись. Сервер рисует пустое поле, сохранённое подставляется после
 * загрузки — и только если человек ещё ничего не набрал.
 */
export function useRememberedDraft(storageKey: string): [string, (next: SetStateAction<string>) => void] {
  const [text, setText] = useState("");

  useEffect(() => {
    const saved = readDraft(storageKey);
    if (saved) setText((current) => current || saved);
  }, [storageKey]);

  const update = useCallback(
    (next: SetStateAction<string>) =>
      setText((current) => {
        const value = typeof next === "function" ? next(current) : next;
        writeDraft(storageKey, value);
        return value;
      }),
    [storageKey],
  );

  return [text, update];
}

function readDraft(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeDraft(key: string, value: string): void {
  try {
    if (value.trim()) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Хранилище закрыто или полно: черновик живёт, пока открыта страница
  }
}
