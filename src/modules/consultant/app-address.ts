/**
 * Короткий адрес приложения человека. Эксперт описывает адрес шаблоном с русским словом вместо имени — «адрес.apps.example.com»:
 * значит, у его приложений общий домен, и человек часто пишет только имя — «sveta-nails». Такой адрес однозначен.
 */

// «адрес.apps.example.com», «имя.site.ru»: русское слово-заготовка перед доменом
const APP_DOMAIN_TEMPLATE = /(?<![\p{L}\p{N}.-])[а-яё]+\.((?:[a-z0-9-]+\.)+[a-z]{2,})/giu;

/** Домены приложений, описанные шаблоном в текстах эксперта. */
export function appDomainsIn(texts: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const text of texts) for (const found of text.matchAll(APP_DOMAIN_TEMPLATE)) domains.add(found[1]!.toLowerCase());
  return [...domains];
}

/**
 * Хост — «имя.домен приложений», а имя человек написал отдельным словом: «адрес sveta-nails» → sveta-nails.apps.example.com.
 * Имя — одно латинское слово с цифрами и дефисами; с точкой после него это уже другой адрес.
 */
export function isAppNameHost(host: string, appDomains: readonly string[], texts: readonly string[]): boolean {
  const domain = appDomains.find((candidate) => host.endsWith(`.${candidate}`));
  if (!domain) return false;
  const name = host.slice(0, -domain.length - 1);
  // Только латиница, цифры и дефис: имя вставляется в выражение как есть
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return false;
  const word = new RegExp(`(?<![\\p{L}\\p{N}./@-])${name}(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}])`, "iu");
  return texts.some((text) => word.test(text));
}
