import { getDatabase } from "@/modules/platform/db";
import { isWebPushEndpoint, saveWebChatSubscription, type WebPushSubscription } from "@/modules/web-chat";
import { currentVisitor, jsonResponse } from "@/modules/web-chat/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const isText = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit;

function subscriptionOf(value: unknown): WebPushSubscription | null {
  const raw = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!raw || !isText(raw.endpoint, 2000) || !isWebPushEndpoint(raw.endpoint)) return null;
  if (!isText(raw.keys?.p256dh, 200) || !isText(raw.keys?.auth, 200)) return null;
  return { endpoint: raw.endpoint, keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth } };
}

/** Подписка посетителя на уведомления о новых сообщениях; `{ subscription: null }` — отписка. */
export async function POST(request: Request) {
  const visitor = await currentVisitor();
  if (!visitor) return jsonResponse({ error: "Откройте чат по ссылке заново" }, 401);
  const body = (await request.json().catch(() => null)) as { subscription?: unknown } | null;
  if (body?.subscription === null) {
    await saveWebChatSubscription(getDatabase().db, visitor, null);
    return jsonResponse({ ok: true });
  }
  const subscription = subscriptionOf(body?.subscription);
  if (!subscription) return jsonResponse({ error: "Подписка не распознана" }, 400);
  await saveWebChatSubscription(getDatabase().db, visitor, subscription);
  return jsonResponse({ ok: true });
}
