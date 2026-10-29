import { isBuiltFromTemplate } from "./text-link";

/**
 * Короткая ссылка `https://<PUBLIC_BASE_URL>/i/<код>` вместо полной ссылки с подставленным текстом: в чате не 2–3 тысячи
 * знаков процентов, а адрес из латиницы. Полная хранится у нас (`text_short_links`), адрес `/i/<код>` перенаправляет.
 */

/** Латиница и цифры без похожих: нет 0 O o 1 l I i — код легко прочитать и переписать. */
export const SHORT_CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
export const SHORT_CODE_LENGTH = 7;
const CODE = new RegExp(`^[${SHORT_CODE_ALPHABET}]{6,8}$`);

export function newShortCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SHORT_CODE_LENGTH));
  return [...bytes].map((byte) => SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length]).join("");
}

/** Код из допустимых знаков и разумной длины: другие в базу не идут. */
export const isShortCode = (code: string) => CODE.test(code);

export interface ShortLinkLookup {
  /** Полная ссылка и шаблон, которым она собрана; нет такого кода — `null`. */
  lookup(code: string): Promise<{ target: string; template: string } | null>;
  /** Сервисы из шаблонов лидмагнитов — для страницы «Ссылка устарела». */
  services(): Promise<string[]>;
}

export type ShortLinkResponse = { status: 302; location: string } | { status: 200; html: string } | { status: 404 };

/** Ответ на `GET /i/<код>`: 302 только на адрес, собранный шаблоном; иначе — «Ссылка устарела»; плохой код — 404. */
export async function shortLinkResponse(code: string, deps: ShortLinkLookup): Promise<ShortLinkResponse> {
  if (!isShortCode(code)) return { status: 404 };
  const found = await deps.lookup(code);
  if (found && isBuiltFromTemplate(found.target, found.template)) return { status: 302, location: found.target };
  return { status: 200, html: expiredPage(await deps.services()) };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function expiredPage(services: readonly string[]): string {
  const links = services.map((service) => `<p><a href="${escapeHtml(service)}">${escapeHtml(service.replace(/^https:\/\//, "").replace(/\/$/, ""))}</a></p>`).join("");
  return (
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ссылка устарела</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#222}</style></head>` +
    `<body><h1>Ссылка устарела</h1><p>Попросите в чате новую ссылку${services.length > 0 ? " или откройте сервис:" : "."}</p>${links}</body></html>`
  );
}
