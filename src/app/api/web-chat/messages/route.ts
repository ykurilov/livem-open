import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { readWebChat, sendWebChatMessage } from "@/modules/web-chat";
import { clientAddress, currentVisitor, jsonResponse, webChatDependencies } from "@/modules/web-chat/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_VISITOR = { error: "Откройте чат по ссылке заново" };

/** Лента посетителя; `since` — только новее (страница опрашивает раз в несколько секунд). */
export async function GET(request: Request) {
  const visitor = await currentVisitor();
  if (!visitor) return jsonResponse(NO_VISITOR, 401);
  const sinceParam = new URL(request.url).searchParams.get("since");
  const since = sinceParam ? new Date(sinceParam) : undefined;
  const items = await readWebChat(getDatabase().db, systemClock, visitor, { since: since && !Number.isNaN(since.getTime()) ? since : undefined });
  return jsonResponse({ items });
}

/** Сообщение посетителя. */
export async function POST(request: Request) {
  const visitor = await currentVisitor();
  if (!visitor) return jsonResponse(NO_VISITOR, 401);
  const body = (await request.json().catch(() => null)) as { text?: unknown; clientId?: unknown; code?: unknown } | null;
  if (typeof body?.text !== "string" || typeof body.clientId !== "string") return jsonResponse({ error: "Напишите сообщение" }, 400);
  const result = await sendWebChatMessage(await webChatDependencies(), visitor, {
    text: body.text,
    clientId: body.clientId,
    address: clientAddress(request.headers),
    ...(typeof body.code === "string" && { code: body.code }),
  });
  if (result.ok) return jsonResponse({ ok: true, item: result.item });
  const status =
    result.reason === "too_fast" || result.reason === "too_many" ? 429 : result.reason === "retry" ? 503 : result.reason === "other_chat" ? 409 : 400;
  return jsonResponse({ error: result.error, ...(result.reason === "other_chat" && { current: result.current }) }, status);
}
