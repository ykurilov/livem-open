import { getDatabase } from "@/modules/platform/db";
import { createShortLinkStore, shortLinkResponse } from "@/modules/text-links/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Короткая ссылка `/i/<код>`: открыта без входа, 302 на полную ссылку с подставленным текстом. */
export async function GET(_request: Request, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  // Адрес приложения для разбора не нужен: хранилище только читает
  const response = await shortLinkResponse(code, createShortLinkStore(getDatabase().db, ""));
  if (response.status === 302) return new Response(null, { status: 302, headers: { location: response.location, "cache-control": "no-store" } });
  if (response.status === 404) return new Response("Не найдено", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(response.html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
