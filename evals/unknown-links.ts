import { appDomainsIn, isAppNameHost } from "@/modules/consultant/app-address";

/**
 * Ссылки в ответе консультанта для сквозных проверок (`evals/checks.ts`). В бою ссылки проверяет служба SDK
 * (`unknownLinks` из `@ykurilov/agent-chat-reply-check`), а здесь нужен список найденных ссылок для отчёта.
 */

/** http(s)://…, www.…, домен с путём (t.me/…, bit.ly/…). Почта и @имена — не ссылки: перед доменом нет «@». */
const LINK = /(?:https?:\/\/|(?<![\p{L}\d@.\/-])www\.)[^\s<>«»"'()]+|(?<![\p{L}\d@.\/-])(?:[\p{L}\d-]+\.)+(?:[a-z]{2,6}|рф)\/[^\s<>«»"'()]*/giu;

/** Знаки препинания в конце — от фразы, а не от ссылки. */
const TRAILING = /[.,!?;:…]+$/u;

/** Ссылки текста по порядку появления. */
export function linksIn(text: string): string[] {
  return (text.match(LINK) ?? []).map((link) => link.replace(TRAILING, "")).filter(Boolean);
}

/** Без utm-меток: их дописывает приложение к ссылке продукта на выходе к человеку (`productLinks`), модель их не пишет. */
function withoutUtm(link: string): string {
  const [base, query] = link.split("?", 2) as [string, string?];
  if (query === undefined) return link;
  const [params = "", hash] = query.split("#", 2) as [string, string?];
  const kept = params.split("&").filter((pair) => pair !== "" && !/^utm_/i.test(pair));
  return `${base}${kept.length ? `?${kept.join("&")}` : ""}${hash === undefined ? "" : `#${hash}`}`;
}

/** Адрес без схемы, «www.», utm-меток и косой черты в конце; домен — без учёта регистра: «https://A.ru/x» и «a.ru/x» — одна ссылка. */
function sameAddress(link: string): string {
  const bare = withoutUtm(link).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  const slash = bare.indexOf("/");
  return slash < 0 ? bare.toLowerCase() : bare.slice(0, slash).toLowerCase() + bare.slice(slash);
}

// Голый адрес в знакомом тексте: человек пишет «sveta-nails.apps.example.com» без https:// и без пути
const BARE_HOST = /(?<![\p{L}\p{N}@./-])(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?![\p{L}\p{N}/-])/giu;

/**
 * Ссылки ответа, которых нет в знакомых текстах. Законны и голые адреса из них, и короткий адрес приложения:
 * имя из знакомых текстов на домене приложений, описанном шаблоном «адрес.apps.example.com».
 */
export function unknownLinksIn(text: string, known: readonly string[]): string[] {
  const allowed = new Set([...known.flatMap(linksIn), ...known.flatMap((one) => one.match(BARE_HOST) ?? [])].map(sameAddress));
  const appDomains = appDomainsIn(known);
  return linksIn(text).filter((link) => {
    const address = sameAddress(link);
    return !allowed.has(address) && !(!address.includes("/") && isAppNameHost(address, appDomains, known));
  });
}
