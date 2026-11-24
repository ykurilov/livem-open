import { eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../platform/db";
import { parseSiteList, siteAllowed, type SiteList } from "./allowed-sites";
import { chatApiSites } from "./schema";

/** Разрешённые сайты лидмагнита; не задавали — пусто (работает везде). */
export async function readAllowedSites(db: DatabaseExecutor, leadMagnetId: string): Promise<string[]> {
  const [row] = await db.select({ sites: chatApiSites.sites }).from(chatApiSites).where(eq(chatApiSites.leadMagnetId, leadMagnetId));
  return row?.sites ?? [];
}

/** Список из поля кабинета: сохраняется разобранным, непринятые строки возвращаются эксперту. */
export async function saveAllowedSites(db: DatabaseExecutor, leadMagnetId: string, text: string): Promise<SiteList> {
  const list = parseSiteList(text);
  await db
    .insert(chatApiSites)
    .values({ leadMagnetId, sites: list.sites })
    .onConflictDoUpdate({ target: chatApiSites.leadMagnetId, set: { sites: list.sites, updatedAt: new Date() } });
  return list;
}

/** С какого сайта пришёл запрос браузера. `own` — со страницы самого приложения (живой просмотр в кабинете). */
export interface BrowserSite {
  origin: string | null;
  own: boolean;
}

/**
 * Работает ли чат лидмагнита на этом сайте; нет — понятная причина для консоли браузера. Свой адрес приложения разрешён
 * всегда. Проверка — до любых действий: на сайте не из списка разговор не начинается и модель не тратится.
 */
export async function browserSiteRefusal(db: DatabaseExecutor, leadMagnetId: string, site: BrowserSite): Promise<string | null> {
  if (site.own || siteAllowed(await readAllowedSites(db, leadMagnetId), site.origin)) return null;
  const host = hostOf(site.origin);
  const where = host ? `на сайте ${host}` : "на сайте, который не назвал свой адрес";
  return `Чат лидмагнита не работает ${where}: его нет в списке разрешённых сайтов. Эксперт добавляет сайт в кабинете: «Публикация» → «Встроить на сайт».`;
}

function hostOf(origin: string | null): string | null {
  if (!origin || origin === "null") return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}
