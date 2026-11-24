// Список сайтов, где работает виджет лидмагнита. Чистые правила: разбор того, что эксперт вписал, и сверка с `Origin`.

const MASK_PREFIX = "*.";
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface SiteList {
  /** Домены (`example.ru`) и маски поддоменов (`*.example.ru`) в том виде, в каком их шлёт браузер. */
  sites: string[];
  /** Строки, в которых домена не узнать, — как их написали. */
  invalid: string[];
}

/**
 * Список из поля кабинета: по строке или через запятую. Адрес страницы, протокол, порт и заглавные убираются — остаётся
 * домен; русские домены — в punycode. Маска `*.example.ru` — только поддомены и не шире домена второго уровня.
 */
export function parseSiteList(text: string): SiteList {
  const sites = new Set<string>();
  const invalid: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const site = normalizeSite(entry);
    if (site) sites.add(site);
    else invalid.push(entry);
  }
  return { sites: [...sites], invalid };
}

/** Сайт посетителя (`Origin`) есть в списке. Пустой список — виджет работает везде. Сайт не назвался — нет. */
export function siteAllowed(sites: readonly string[], origin: string | null | undefined): boolean {
  if (sites.length === 0) return true;
  const host = originHost(origin);
  if (!host) return false;
  return sites.some((site) => (site.startsWith(MASK_PREFIX) ? host.endsWith(site.slice(1)) : host === site));
}

function normalizeSite(entry: string): string | null {
  const lower = entry.toLowerCase();
  const mask = lower.startsWith(MASK_PREFIX);
  const host = hostOf(mask ? lower.slice(MASK_PREFIX.length) : lower.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""));
  if (!host) return null;
  if (mask && host.split(".").length < 2) return null;
  return mask ? `${MASK_PREFIX}${host}` : host;
}

/** Домен из записи без протокола: путь и порт отрезаются, проверяется каждая часть. */
function hostOf(value: string): string | null {
  const bare = value.split(/[/?#]/, 1)[0]!.replace(/:\d*$/, "");
  if (!bare || /\s/.test(bare)) return null;
  let host: string;
  try {
    host = new URL(`http://${bare}`).hostname;
  } catch {
    return null;
  }
  return host.split(".").every((label) => LABEL.test(label)) ? host : null;
}

function originHost(origin: string | null | undefined): string | null {
  if (!origin || origin === "null") return null;
  try {
    return new URL(origin).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
