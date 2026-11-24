/** Хранилище браузера без исключений: приватный режим или запрет сайта — живём тем, что в памяти страницы. */
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Без хранилища — только то, что в памяти страницы
  }
}

export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Нечего убирать
  }
}
