import { getDatabase } from "@/modules/platform/db";
import { markWebChatAway } from "@/modules/web-chat";
import { currentVisitor } from "@/modules/web-chat/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Страница скрыта: следующий ответ придёт уведомлением. Шлётся `navigator.sendBeacon`, ответ никто не читает. */
export async function POST() {
  const visitor = await currentVisitor();
  if (visitor) await markWebChatAway(getDatabase().db, visitor);
  return new Response(null, { status: 204 });
}
