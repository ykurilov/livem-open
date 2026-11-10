import { lt, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../platform/db";
import { webChatLimits } from "./schema";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface WebChatLimit {
  /** Что и чьё считаем: `session:<адрес>`. */
  key: string;
  limit: number;
  windowMs: number;
}

/** Открытий чата с одного адреса в минуту — с cookie и без: перебор кодов и вход в чужие лидмагниты. */
export const sessionsPerAddress = (address: string): WebChatLimit => ({ key: `session:${address}`, limit: 120, windowMs: MINUTE_MS });
/** Загрузок страницы чата с одного адреса в минуту: страница тоже отвечает, есть ли такой код. */
export const pagesPerAddress = (address: string): WebChatLimit => ({ key: `page:${address}`, limit: 120, windowMs: MINUTE_MS });
/** Новых посетителей с одного адреса в час: вебинар из одного офиса проходит, скрипт с сотнями посетителей — нет. */
export const newVisitorsPerAddress = (address: string): WebChatLimit => ({ key: `visitor:${address}`, limit: 150, windowMs: HOUR_MS });
/** Сообщений с одного адреса в минуту по всем его посетителям: посетителей не размножить ради расходов на модель. */
export const messagesPerAddress = (address: string): WebChatLimit => ({ key: `message:${address}`, limit: 120, windowMs: MINUTE_MS });

/** Старые окна удаляются изредка, попутно со счётом. */
const CLEANUP_CHANCE = 0.01;
const KEEP_WINDOWS_MS = 2 * 24 * HOUR_MS;

/** Засчитать попытку. `false` — предел окна уже выбран, попытку не пускать. */
export async function takeWebChatLimit(db: DatabaseExecutor, now: Date, limit: WebChatLimit, random: () => number = Math.random): Promise<boolean> {
  const windowStart = new Date(Math.floor(now.getTime() / limit.windowMs) * limit.windowMs);
  const [row] = await db
    .insert(webChatLimits)
    .values({ key: limit.key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [webChatLimits.key, webChatLimits.windowStart], set: { count: sql`${webChatLimits.count} + 1` } })
    .returning({ count: webChatLimits.count });
  if (random() < CLEANUP_CHANCE) await db.delete(webChatLimits).where(lt(webChatLimits.windowStart, new Date(now.getTime() - KEEP_WINDOWS_MS)));
  return (row?.count ?? 0) <= limit.limit;
}
