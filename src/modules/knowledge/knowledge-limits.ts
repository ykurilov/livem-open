/** Пределы файлов базы знаний: их проверяет и сервер, и окно выбора файла в браузере. */

/**
 * Предел текста баз на один лидмагнит, в знаках: ≈ 70–90 тыс. токенов русского текста. Окно моделей каталога — 1 млн
 * токенов, но SDK сжимает историю с 200 тыс. токенов контекста: база не больше половины порога оставляет место разговору.
 */
export const KNOWLEDGE_MAX_CHARS = 200_000;
/** Текстовый файл больше 1 МБ в предел знаков всё равно не уложится. */
export const KNOWLEDGE_FILE_MAX_BYTES = 1024 * 1024;
/** PDF тяжелее текста: шрифты и вёрстка. Предел — с запасом под форму в 11 МБ (`next.config.mjs`). */
export const KNOWLEDGE_PDF_MAX_BYTES = 10 * 1024 * 1024;
/**
 * Больше страниц PDF не разбираем: в предел знаков лидмагнита укладывается около сотни страниц текста, а разбор тысяч
 * страниц надолго займёт сервер.
 */
export const KNOWLEDGE_PDF_MAX_PAGES = 500;
/** Дольше разбор одного PDF не ждём. */
export const KNOWLEDGE_PDF_TIMEOUT_MS = 60_000;
export const KNOWLEDGE_EXTENSIONS = [".txt", ".md", ".markdown", ".pdf"] as const;

export const isPdfName = (name: string) => name.toLowerCase().endsWith(".pdf");

/** Предел размера файла по его имени. */
export const knowledgeFileMaxBytes = (name: string) => (isPdfName(name) ? KNOWLEDGE_PDF_MAX_BYTES : KNOWLEDGE_FILE_MAX_BYTES);

/** «1 МБ», «10 МБ» — для ошибок о размере. */
export const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} МБ`;

const formatNumber = new Intl.NumberFormat("ru-RU");
/** «200 000» с обычным пробелом: так число находится и в тексте ошибки, и в тестах. */
export const formatChars = (count: number) => formatNumber.format(count).replace(/\s/g, " ");
