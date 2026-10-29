/**
 * Режет текст на куски не длиннее `limit`: по границе абзаца, иначе строки, иначе пробела, иначе жёстко.
 * Режем до экранирования (в Telegram — HTML), поэтому «&amp;» и «&lt;» не рвутся; эмодзи (две кодовые единицы) тоже целы.
 */
export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return text ? [text] : [];
  const chunks: string[] = [];
  let start = 0;
  while (text.length - start > limit) {
    const windowEnd = start + limit;
    const boundary = ["\n\n", "\n", " "]
      .map((separator) => text.lastIndexOf(separator, windowEnd))
      .find((position) => position > start);
    if (boundary === undefined) {
      // Не режем эмодзи пополам: нижняя половина пары не должна оказаться в начале следующего куска
      const isSplitPair = /[\uD800-\uDBFF]/.test(text[windowEnd - 1] ?? "");
      const end = isSplitPair ? windowEnd - 1 : windowEnd;
      chunks.push(text.slice(start, end));
      start = end;
      continue;
    }
    const chunk = text.slice(start, boundary).trimEnd();
    if (chunk) chunks.push(chunk);
    start = boundary;
    while (start < text.length && /\s/.test(text[start]!)) start += 1;
  }
  const rest = text.slice(start);
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

/** Куски дополнительных сообщений по порядку; пустые сообщения выпадают. */
export function followUpChunks(followUps: string[] | undefined, limit: number): string[] {
  return (followUps ?? []).filter((text) => text.trim() !== "").flatMap((text) => splitText(text, limit));
}
