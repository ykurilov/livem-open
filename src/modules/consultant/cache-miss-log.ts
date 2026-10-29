// Журнал службы консультанта: строку SDK «[промах кэша]» дополняет день программы и нода чата — промахи раскладываются
// по дням и нодам. Остальные строки уходят как есть.

const CACHE_MISS = "[промах кэша]";
const CHAT_ID = /чат=(\S+)/;

export interface CacheMissLogInput {
  /** Владелец чата (человек или владелец тестового чата); нет чата — `null`. */
  ownerOf(chatId: string): Promise<string | null>;
  /** Место чата в сценарии: нода и день программы (`flow.readRun`). */
  readRun(ownerId: string, chatId: string): Promise<{ state: string; day?: { day: number } } | null>;
  log(line: string): void;
}

/** `logError` службы чата. Сценарий не прочитался — строка без дня и ноды, но не теряется. */
export function cacheMissLog(input: CacheMissLogInput): (line: string) => Promise<void> {
  return async (line) => {
    const chatId = line.startsWith(CACHE_MISS) ? line.match(CHAT_ID)?.[1] : undefined;
    if (!chatId) return input.log(line);
    try {
      const ownerId = await input.ownerOf(chatId);
      const run = ownerId ? await input.readRun(ownerId, chatId) : null;
      if (!run) return input.log(line);
      input.log(`${line}${run.day ? ` день=${run.day.day}` : ""} нода=${run.state}`);
    } catch {
      input.log(line);
    }
  };
}
