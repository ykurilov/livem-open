import { z } from "zod";

/**
 * Ссылка продукта лидмагнита (курс, тариф): по ней человек оплачивает, а мы узнаём, кто это. Модель пишет её как есть,
 * метки дописывает код на выходе к человеку (`tagProductLinks`). Без браузерных и серверных зависимостей: тем же кодом
 * размечает и экран «Проверки».
 */
export const productLinkSchema = z.object({
  /** Начало ссылки: страница продукта и всё, что глубже неё. */
  url: z
    .string()
    .trim()
    .regex(/^https?:\/\/[^\s/?#]+\.[^\s/?#]+(\/[^\s?#]*)?$/i, "Ссылка продукта — адрес страницы вида https://сайт/путь, без параметров"),
  /** Название продукта для поздравления и напоминания («Свой ИИ-агент»). */
  title: z.string().trim().min(1, "У ссылки продукта должно быть название"),
  /** Метка кампании `utm_campaign`: по ней видно продукт в заказах. */
  campaign: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{1,64}$/i, "Метка кампании — латиница, цифры, «_» и «-», до 64 знаков"),
});

export type ProductLink = z.infer<typeof productLinkSchema>;

/** Чем пометить ссылку: канал (`utm_medium`) и личный код человека в этом прохождении (`utm_content`). */
export interface ProductLinkTag {
  medium: string;
  content: string;
}

/** Источник меток: кто дал ссылку. */
export const PRODUCT_LINK_SOURCE = "vasily";

// Как ссылки в тексте находит проверка ссылок SDK (`unknownLinks`): с протоколом, с www и «сайт.ру/путь»
const LINK = /(?:https?:\/\/|(?<![\p{L}\d@./-])www\.)[^\s<>«»"'()]+|(?<![\p{L}\d@./-])(?:[\p{L}\d-]+\.)+(?:[a-z]{2,6}|рф)\/[^\s<>«»"'()]*/giu;
const TRAILING = /[.,!?;:…]+$/u;

/** Адрес без протокола, www и косых в конце; сайт — строчными. */
function bareAddress(link: string): string {
  const bare = link.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  const slash = bare.indexOf("/");
  return slash < 0 ? bare.toLowerCase() : bare.slice(0, slash).toLowerCase() + bare.slice(slash);
}

/** Ссылка ведёт на страницу продукта или глубже неё. */
export function isProductLink(link: string, product: ProductLink): boolean {
  const address = bareAddress(link.split(/[?#]/)[0]!);
  const own = bareAddress(product.url);
  return address === own || address.startsWith(`${own}/`);
}

function taggedLink(link: string, product: ProductLink, tag: ProductLinkTag): string {
  // Ссылку без протокола («сайт.ру/путь») разбираем как https и отдаём без протокола, как её написали
  const withScheme = /^https?:\/\//i.test(link);
  let url: URL;
  try {
    url = new URL(withScheme ? link : `https://${link}`);
  } catch {
    return link;
  }
  // Свои параметры ссылки остаются; чужие и прежние метки уступают нашим
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
  url.searchParams.append("utm_source", PRODUCT_LINK_SOURCE);
  url.searchParams.append("utm_medium", tag.medium);
  url.searchParams.append("utm_campaign", product.campaign);
  url.searchParams.append("utm_content", tag.content);
  // Путь — как в тексте (кириллица, регистр): `URL` его перекодировал бы
  const path = link.replace(/^https?:\/\//i, "").split(/[?#]/)[0]!;
  const scheme = withScheme ? link.slice(0, link.indexOf("//") + 2) : "";
  return `${scheme}${path}${url.search}${url.hash}`;
}

/** Есть ли в тексте ссылка какого-нибудь продукта. */
export function containsProductLink(text: string, products: readonly ProductLink[]): boolean {
  return (text.match(LINK) ?? []).some((found) => products.some((product) => isProductLink(found.replace(TRAILING, ""), product)));
}

/** Ссылки продуктов в тексте — с метками человека; остальной текст как есть. Повторная разметка ничего не меняет. */
export function tagProductLinks(text: string, products: readonly ProductLink[], tag: ProductLinkTag): string {
  if (products.length === 0) return text;
  return text.replace(LINK, (found) => {
    const link = found.replace(TRAILING, "");
    const product = products.find((candidate) => isProductLink(link, candidate));
    return product ? taggedLink(link, product, tag) + found.slice(link.length) : found;
  });
}
