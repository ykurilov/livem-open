import { createHash, timingSafeEqual } from "node:crypto";

/** Сравнение секрета из запроса с ожидаемым: время не зависит от того, сколько знаков совпало. */
export function secretsMatch(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Секрет вебхука только из латинских букв и цифр. Общий секрет бота содержит «-» и «_», а ВК и Max
 * принимают в ключе не всё (Max: только `A-Z a-z 0-9` и дефис). Подмена детерминирована: при подключении
 * и при проверке запроса получается одно и то же значение.
 */
export function alphanumericSecret(secret: string): string {
  return secret.replace(/[^A-Za-z0-9]/g, "x");
}
