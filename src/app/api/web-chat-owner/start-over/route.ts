import { accessErrorResponse, requireUser } from "@/modules/access";
import { startWebChatOverAsNewVisitor } from "@/modules/web-chat";
import { jsonResponse, readVisitorToken, rememberVisitorToken, webChatDependencies } from "@/modules/web-chat/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * «Начать разговор заново» на веб-странице лидмагнита — только для вошедшего эксперта: его браузер становится новым
 * посетителем, чтобы проверить живую страницу с чистого листа. Адрес вне открытых `/api/web-chat`: посторонних
 * отклоняет и прокси, и эта проверка.
 */
export async function POST(request: Request) {
  try {
    await requireUser();
  } catch (error) {
    return accessErrorResponse(error) ?? Promise.reject(error);
  }
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  const restarted = await startWebChatOverAsNewVisitor(await webChatDependencies(), { token: await readVisitorToken(), code });
  if (restarted.kind === "not_found") return jsonResponse({ error: "Чат не найден: ссылка устарела или лидмагнит снят с публикации" }, 404);
  await rememberVisitorToken(restarted.token);
  return jsonResponse({ ok: true });
}
