import {
  KNOWLEDGE_EXTENSIONS,
  KNOWLEDGE_MAX_CHARS,
  KNOWLEDGE_PDF_MAX_PAGES,
  KNOWLEDGE_PDF_TIMEOUT_MS,
  formatChars,
  isPdfName,
  knowledgeFileMaxBytes,
  megabytes,
} from "./knowledge-limits";

export class InvalidKnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKnowledgeError";
  }
}

export { KNOWLEDGE_EXTENSIONS, KNOWLEDGE_FILE_MAX_BYTES, KNOWLEDGE_MAX_CHARS, KNOWLEDGE_PDF_MAX_BYTES, KNOWLEDGE_PDF_MAX_PAGES, formatChars } from "./knowledge-limits";

/** Пределы разбора PDF; по умолчанию — `KNOWLEDGE_PDF_MAX_PAGES` и `KNOWLEDGE_PDF_TIMEOUT_MS`. */
export interface KnowledgeFileLimits {
  pdfMaxPages?: number;
  pdfTimeoutMs?: number;
}

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

const UNREADABLE_PDF = "Этот PDF не получилось прочитать — сохраните его заново или пришлите текстом .txt";

/** Текст PDF по страницам; PDF не читается, в нём больше страниц или он читается дольше предела — понятная ошибка. */
async function pdfText(bytes: Uint8Array, maxPages: number, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new InvalidKnowledgeError("Этот PDF читается слишком долго — разделите его на несколько или пришлите текстом .txt"));
    }, timeoutMs);
  });
  const reading = (async () => {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // Копия: разбор забирает себе буфер, а байты файла ещё нужны для размера
    const pdf = await getDocumentProxy(bytes.slice());
    try {
      if (pdf.numPages > maxPages) throw new InvalidKnowledgeError(`В PDF ${pdf.numPages} стр., а прочитать можно до ${maxPages} — разделите его на несколько`);
      // Срок вышел, пока документ открывался: страницы уже не разбираем
      if (timedOut) return "";
      return (await extractText(pdf, { mergePages: true })).text;
    } finally {
      await pdf.loadingTask.destroy();
    }
  })();
  // После срока результат разбора никто не ждёт: его ошибка не должна стать необработанной
  reading.catch(() => undefined);
  try {
    return await Promise.race([reading, deadline]);
  } catch (error) {
    if (error instanceof InvalidKnowledgeError) throw error;
    throw new InvalidKnowledgeError(UNREADABLE_PDF);
  } finally {
    clearTimeout(timer);
  }
}

/** Читает загруженный файл в текст базы: .txt, .md или .pdf; не подходит — понятная ошибка для эксперта. */
export async function readKnowledgeFile(
  file: { name: string; bytes: Uint8Array },
  limits: KnowledgeFileLimits = {},
): Promise<{ content: string; charCount: number }> {
  const name = file.name.toLowerCase();
  if (!KNOWLEDGE_EXTENSIONS.some((extension) => name.endsWith(extension))) throw new InvalidKnowledgeError("Подойдёт файл .txt, .md или .pdf");
  const pdf = isPdfName(name);
  const maxBytes = knowledgeFileMaxBytes(name);
  if (file.bytes.byteLength > maxBytes) throw new InvalidKnowledgeError(`${pdf ? "PDF" : "Файл"} больше ${megabytes(maxBytes)} — разделите его на несколько`);
  const text = pdf
    ? await pdfText(file.bytes, limits.pdfMaxPages ?? KNOWLEDGE_PDF_MAX_PAGES, limits.pdfTimeoutMs ?? KNOWLEDGE_PDF_TIMEOUT_MS)
    : decoded(file.bytes);
  if (!pdf && BINARY.test(text)) throw new InvalidKnowledgeError("Это не текст — сохраните файл как простой текст .txt или .md");
  const content = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!content) {
    throw new InvalidKnowledgeError(
      pdf ? "В PDF нет текста — похоже, это скан или фото страниц. Пришлите PDF с текстом или сам текст файлом .txt" : "Файл пустой — в нём нет текста",
    );
  }
  const charCount = [...content].length;
  if (charCount > KNOWLEDGE_MAX_CHARS) {
    throw new InvalidKnowledgeError(
      `В файле ${formatChars(charCount)} знаков, а консультанту лидмагнита помещается до ${formatChars(KNOWLEDGE_MAX_CHARS)} знаков — сократите или разделите файл`,
    );
  }
  return { content, charCount };
}
