import { getDatabase } from "@/modules/platform/db";
import { webChatImagePath, webChatImageResponse } from "@/modules/web-chat";
import { currentVisitor } from "@/modules/web-chat/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Картинка из сообщения бота — только тому посетителю, кому сообщение ушло. */
export async function GET(_request: Request, context: { params: Promise<{ messageId: string }> }) {
  const visitor = await currentVisitor();
  const path = visitor ? await webChatImagePath(getDatabase().db, visitor, (await context.params).messageId) : null;
  if (!path) return new Response("Not found", { status: 404 });
  return webChatImageResponse(path);
}
