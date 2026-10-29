import { z } from "zod";

/**
 * Ссылка с подставленным текстом: сервис эксперта открывается с уже вписанным текстом (App Studio — идея приложения,
 * `https://appstudio.example.com/?idea={text}&type={type}`). Русский текст в ссылке модель сама не кодирует — ошибётся;
 * ссылку собирает инструмент `text_link`, модель вставляет её как есть.
 */

const TEXT = "{text}";
const TYPE = "{type}";

/** Ссылка уходит в мессенджер одним сообщением: у Telegram и ВК предел 4096 знаков, у Max — 4000; остаток — на слова. */
export const MAX_LINK_CHARS = 3000;
/** Полная ссылка за короткой (`/i/<код>`) в мессенджер не уходит, но сервер App Studio принимает адрес до ~8 КБ. */
export const MAX_FULL_LINK_CHARS = 7500;

/** Адрес шаблона; не разобрался — `null`. «#» и «?» разбирает URL, а не поиск по строке. */
function templateUrl(template: string): URL | null {
  try {
    return new URL(template);
  } catch {
    return null;
  }
}

const queryPairs = (url: URL) => url.search.slice(1).split("&").filter(Boolean);
const queryValues = (url: URL) => queryPairs(url).map((pair) => pair.slice(pair.indexOf("=") + 1));

/** Меньше двух букв или цифр в тексте — ссылки с идеей не выйдет. */
const MIN_TEXT_LETTERS = 2;

export const textLinkSchema = z
  .object({
    /** Адрес с подстановками: `{text}` — значение параметра, `{type}` — необязательный второй. */
    template: z.string().trim().regex(/^https:\/\/[^\s/?#]+\.[^\s]+$/i, "Шаблон ссылки — адрес вида https://сайт/?параметр={text}"),
    /** Допустимые значения `{type}`; пусто — без типа. */
    types: z.array(z.string().trim().regex(/^[a-z0-9_-]{1,32}$/i, "Тип — латиница, цифры, «_» и «-»")).max(20).default([]),
    /** Предел текста в знаках: длиннее — инструмент просит модель сократить. */
    maxTextLength: z.number().int().min(20).max(4000),
    /** Что сказать человеку вместе со ссылкой («Откройте ссылку и нажмите «Собрать»»); нет — как велит инструкция. */
    say: z.string().trim().min(1).max(300).optional(),
  })
  .superRefine(({ template }, ctx) => {
    const url = templateUrl(template);
    if (!url || url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", path: ["template"], message: "Шаблон ссылки — адрес вида https://сайт/?параметр={text}" });
      return;
    }
    // «https://appstudio.example.com@evil.com/…» ведёт на evil.com: учётные данные в адресе — обман, а не шаблон
    if (url.username || url.password) {
      ctx.addIssue({ code: "custom", path: ["template"], message: "В шаблоне ссылки не должно быть «имя@» перед сайтом: такая ссылка ведёт на другой сайт" });
      return;
    }
    const values = queryValues(url);
    const placeholders: string[] = template.match(/\{[^}]*\}/g) ?? [];
    if (values.filter((value) => value === TEXT).length !== 1 || placeholders.filter((one) => one === TEXT).length !== 1)
      ctx.addIssue({ code: "custom", path: ["template"], message: "В шаблоне ровно одно {text}, и оно — значение параметра: ?idea={text}" });
    const strange = placeholders.find((one) => one !== TEXT && one !== TYPE);
    if (strange) ctx.addIssue({ code: "custom", path: ["template"], message: `В шаблоне «${strange}»: подставляются только {text} и {type}` });
    if (placeholders.includes(TYPE) && !values.includes(TYPE))
      ctx.addIssue({ code: "custom", path: ["template"], message: "{type} — значение параметра: &type={type}" });
  });

export type TextLink = z.infer<typeof textLinkSchema>;

/**
 * Текст для ссылки: без скобок, апострофа и звёздочки и без знаков в конце. `encodeURIComponent` их не кодирует, а на них
 * мессенджер и проверка ссылок обрывают ссылку. Свои коды (%2E) не годятся: модель, переписывая ссылку, «чинит» их
 * обратно (eval 21.10), и ссылка перестаёт совпадать с собранной.
 */
function linkSafeText(text: string): string {
  return text
    .replace(/[()*]/g, "")
    .replace(/'/g, "’")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[.,!?;:…]+$/u, "")
    .trim();
}

export type BuiltTextLink = { ok: true; link: string } | { ok: false; error: string };

/** Ссылка по шаблону: текст и тип закодированы; без типа его параметр уходит. Ошибки — понятным текстом для модели. */
export function buildTextLink(
  config: TextLink,
  input: { text: string; type?: string | undefined },
  options: { maxLinkChars?: number } = {},
): BuiltTextLink {
  const maxLinkChars = options.maxLinkChars ?? MAX_LINK_CHARS;
  const text = input.text.trim();
  if (!text) return { ok: false, error: "Текст пустой: напиши текст, который встанет в ссылку." };
  const safe = linkSafeText(text);
  if ((safe.match(/[\p{L}\p{N}]/gu) ?? []).length < MIN_TEXT_LETTERS)
    return { ok: false, error: `Текст слишком короткий: после очистки от кавычек, скобок и знаков осталось «${safe}». Напиши, что сделать, словами.` };
  if (text.length > config.maxTextLength)
    return {
      ok: false,
      error: `Текст — ${text.length} знаков, а в ссылку помещается не больше ${config.maxTextLength}. Сократи текст: оставь главное — что это, для кого, личные детали — и вызови снова.`,
    };
  const type = input.type?.trim() || undefined;
  if (type && !config.types.includes(type))
    return { ok: false, error: `Типа «${type}» нет. Типы: ${config.types.join(", ") || "без типа"}; можно без типа.` };

  const url = templateUrl(config.template)!;
  const params = queryPairs(url).flatMap((pair) => {
      const at = pair.indexOf("=");
      const value = pair.slice(at + 1);
    if (value === TEXT) return [`${pair.slice(0, at)}=${encodeURIComponent(safe)}`];
    if (value === TYPE) return type ? [`${pair.slice(0, at)}=${encodeURIComponent(type)}`] : [];
    return [pair];
  });
  const link = `${url.origin}${url.pathname}?${params.join("&")}${url.hash}`;
  if (link.length > maxLinkChars)
    return {
      ok: false,
      error: `Ссылка выходит ${link.length} знаков, а можно не больше ${maxLinkChars}: русская буква в ссылке занимает 6 знаков. Сократи текст и вызови снова.`,
    };
  return { ok: true, link };
}

/**
 * Адрес собран этим шаблоном: https, без «имя@», тот же сайт, путь и «#», только параметры шаблона, постоянные — с его
 * значениями. Так перенаправление по короткой ссылке не уводит на чужой адрес, даже если в базе окажется другой.
 */
export function isBuiltFromTemplate(target: string, template: string): boolean {
  const own = templateUrl(template);
  const url = templateUrl(target);
  if (!own || !url || url.protocol !== "https:" || url.username || url.password) return false;
  if (url.origin !== own.origin || url.pathname !== own.pathname || url.hash !== own.hash) return false;
  const expected = new Map(queryPairs(own).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  return queryPairs(url).every((pair) => {
    const key = pair.slice(0, pair.indexOf("="));
    const value = expected.get(key);
    return value !== undefined && (value === TEXT || value === TYPE || value === pair.slice(pair.indexOf("=") + 1));
  });
}
