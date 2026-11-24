import { openWebChat, webChatOpenedAnswer, webPushPublicKey } from "@/modules/web-chat";
import { clientAddress, jsonResponse, readVisitorToken, rememberVisitorToken, webChatDependencies } from "@/modules/web-chat/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Открытие чата по ссылке: посетитель из cookie (или по одноразовому коду `resume` — веб-приложение с экрана «Домой»
 * начинает без cookie), новый — с новым токеном в cookie. Разговор этого лидмагнита начинается, если сейчас не идёт.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { code?: unknown; resume?: unknown; timeZone?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  const resume = typeof body?.resume === "string" ? body.resume : null;
  const timeZone = typeof body?.timeZone === "string" ? body.timeZone.slice(0, 100) : null;
  const cookieToken = await readVisitorToken();
  const opened = await openWebChat(await webChatDependencies(), { token: cookieToken, resume, code, address: clientAddress(request.headers), timeZone });
  if ((opened.kind === "opened" || opened.kind === "retry" || opened.kind === "closed") && opened.issued) await rememberVisitorToken(opened.token);
  const answer = webChatOpenedAnswer(opened);
  return jsonResponse(opened.kind === "opened" ? { ...answer.body, pushKey: webPushPublicKey() } : answer.body, answer.status);
}
