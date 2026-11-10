export class InvalidKnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKnowledgeError";
  }
}

/**
 * Предел текста баз на один лидмагнит, в знаках: ≈ 70–90 тыс. токенов русского текста. Окно моделей каталога — 1 млн
 * токенов, но SDK сжимает историю с 200 тыс. токенов контекста: база не больше половины порога оставляет место разговору.
 */
export const KNOWLEDGE_MAX_CHARS = 200_000;
/** Файл больше 1 МБ в предел знаков всё равно не уложится. */
export const KNOWLEDGE_FILE_MAX_BYTES = 1024 * 1024;
export const KNOWLEDGE_EXTENSIONS = [".txt", ".md", ".markdown"] as const;

const formatNumber = new Intl.NumberFormat("ru-RU");
/** «200 000» с обычным пробелом: так число находится и в тексте ошибки, и в тестах. */
export const formatChars = (count: number) => formatNumber.format(count).replace(/\s/g, " ");

/**
 * Текст файла: UTF-16 по метке порядка байтов («Юникод» в «Блокноте»), иначе UTF-8, а если байты в нём невозможны —
 * Windows-1251 («Блокнот» старых Windows).
 */
function decoded(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

/** Управляющие символы, которых в тексте не бывает: файл на самом деле двоичный. */
const BINARY = /[\u0000-\u0008\u000e-\u001a]/;

/** Читает загруженный файл в текст базы; не подходит — понятная ошибка для эксперта. */
export function readKnowledgeFile(file: { name: string; bytes: Uint8Array }): { content: string; charCount: number } {
  const name = file.name.toLowerCase();
  if (!KNOWLEDGE_EXTENSIONS.some((extension) => name.endsWith(extension))) throw new InvalidKnowledgeError("Подойдёт текстовый файл .txt или .md");
  if (file.bytes.byteLength > KNOWLEDGE_FILE_MAX_BYTES) throw new InvalidKnowledgeError("Файл больше 1 МБ — разделите его на несколько");
  const text = decoded(file.bytes);
  if (BINARY.test(text)) throw new InvalidKnowledgeError("Это не текст — сохраните файл как простой текст .txt или .md");
  const content = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (!content) throw new InvalidKnowledgeError("Файл пустой — в нём нет текста");
  const charCount = [...content].length;
  if (charCount > KNOWLEDGE_MAX_CHARS) {
    throw new InvalidKnowledgeError(
      `В файле ${formatChars(charCount)} знаков, а консультанту лидмагнита помещается до ${formatChars(KNOWLEDGE_MAX_CHARS)} знаков — сократите или разделите файл`,
    );
  }
  return { content, charCount };
}
