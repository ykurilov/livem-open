/**
 * Пояс IANA, где в момент `at` идёт час `hour` (Etc/GMT±N). Дни программы зависят от часа: вечером первым днём
 * считается завтра. Тесты дней берут пояс, где сейчас день, — и не зависят от времени прогона.
 */
export function timeZoneAtHour(hour: number, at: Date = new Date()): string {
  let offset = (((hour - at.getUTCHours()) % 24) + 24) % 24;
  if (offset > 14) offset -= 24;
  // У Etc/GMT знак наоборот: Etc/GMT-8 — это UTC+8
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}
