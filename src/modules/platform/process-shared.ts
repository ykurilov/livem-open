const slots = globalThis as typeof globalThis & Record<string, Promise<unknown> | undefined>;

/**
 * Ресурс, общий для всего процесса (очередь, хранилище переписок): открывается при первом обращении. Неудачная попытка
 * не запоминается — следующий вызов открывает заново (база поднялась позже веба); удачная — одна на всех.
 * В `next dev` модули перезагружаются, поэтому место — в globalThis под ключом `key`.
 */
export function sharedPerProcess<T>(key: string, open: () => Promise<T>): Promise<T> {
  const existing = slots[key] as Promise<T> | undefined;
  if (existing) return existing;
  const attempt = open().catch((error: unknown) => {
    // Освобождаем только своё место: его могла уже занять следующая, удачная попытка
    if (slots[key] === attempt) slots[key] = undefined;
    throw error;
  });
  slots[key] = attempt;
  return attempt;
}
