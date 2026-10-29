import type { VideoChapter } from "./schema";

/** «45», «3:20», «1:02:05» → секунды; не время — `null`. */
export function parseTimeLabel(label: string): number | null {
  const parts = label.trim().split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((part) => part >= 60)) return null;
  return numbers.reduce((total, part) => total * 60 + part, 0);
}

/** Главы из поля формы: по строке «3:20 Название», пустые строки пропускаются. */
export function parseChapterLines(text: string): VideoChapter[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [, time = "", title = ""] = /^(\S+)\s+(.+)$/.exec(line) ?? [];
      const startSeconds = parseTimeLabel(time);
      if (startSeconds === null || !title.trim()) throw new Error(`Строка «${line}»: начните с времени, например «3:20 Примеры»`);
      return { title: title.trim(), startSeconds };
    });
}
