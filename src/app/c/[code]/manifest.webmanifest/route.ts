import { getDatabase } from "@/modules/platform/db";
import { createTokenCipher } from "@/modules/platform/crypto";
import { requireEnv } from "@/modules/platform/env";
import { webChatResumeCode, webChatTitle } from "@/modules/web-chat";
import { currentVisitor } from "@/modules/web-chat/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Манифест веб-приложения чата: его ставят на экран «Домой», чтобы получать уведомления на iPhone.
 * Веб-приложение начинает без cookie браузера, поэтому в `start_url` — одноразовый код входа этого посетителя (`resume`):
 * первый запуск меняет его на собственный токен веб-приложения, сам токен cookie в адрес не попадает.
 */
export async function GET(_request: Request, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  const db = getDatabase().db;
  const visitor = await currentVisitor();
  const title = await webChatTitle(db, code, visitor);
  if (!title) return new Response("Not found", { status: 404 });
  const resume = visitor ? `?resume=${encodeURIComponent(await webChatResumeCode(db, createTokenCipher(requireEnv("BOT_TOKEN_KEY")), visitor))}` : "";
  const manifest = {
    name: title,
    short_name: title.length > 12 ? "Чат" : title,
    start_url: `/c/${encodeURIComponent(code)}${resume}`,
    scope: "/c/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/web-chat/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/web-chat/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "private, no-store" },
  });
}
