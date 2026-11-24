import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { createChannelAdapters } from "@/modules/channels";
import { readSentMessage, readWebChat, sendWebChatMessage, webChatMessengerHandoff, webChatSendAnswer } from "@/modules/web-chat";
import { clientAddress, currentVisitor, jsonResponse, webChatDependencies } from "@/modules/web-chat/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_VISITOR = { error: "Откройте чат по ссылке заново" };

/**
 * Лента посетителя; `since` — только новее (страница опрашивает раз в несколько секунд). `code` — вкладка лидмагнита:
 * в ответе `handoff` — кнопки мессенджеров вместо поля ввода или где разговор продолжается.
 */
export async function GET(request: Request) {
  const visitor = await currentVisitor();
  if (!visitor) return jsonResponse(NO_VISITOR, 401);
  const params = new URL(request.url).searchParams;
  const sinceParam = params.get("since");
  const since = sinceParam ? new Date(sinceParam) : undefined;
  const { db } = getDatabase();
  const items = await readWebChat(db, systemClock, visitor, { since: since && !Number.isNaN(since.getTime()) ? since : undefined });
  const code = params.get("code");
  const handoff = code ? await webChatMessengerHandoff(db, createChannelAdapters(), visitor, code) : null;
  return jsonResponse({ items, handoff });
}

/** Сообщение посетителя: JSON или форма с фото. */
export async function POST(request: Request) {
  const visitor = await currentVisitor();
  if (!visitor) return jsonResponse(NO_VISITOR, 401);
  const message = await readSentMessage(request);
  if (!message.ok) return jsonResponse({ error: message.error }, message.status);
  const result = await sendWebChatMessage(await webChatDependencies(), visitor, { ...message, address: clientAddress(request.headers) });
  const answer = webChatSendAnswer(result);
  return jsonResponse(answer.body, answer.status);
}
