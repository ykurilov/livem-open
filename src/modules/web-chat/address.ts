/**
 * Адрес посетителя для ограничений. За nginx — `X-Real-IP`: nginx ставит его сам (`$remote_addr`), посетитель его
 * не подменит. Без него — последний адрес `X-Forwarded-For`: его дописал ближайший прокси, а начало строки посетитель
 * может прислать любым.
 */
export function clientAddress(headers: Headers): string {
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, 100);
  const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return forwarded ? forwarded.slice(0, 100) : "unknown";
}
