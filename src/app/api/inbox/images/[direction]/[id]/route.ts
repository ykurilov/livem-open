import { accessErrorResponse, requireUser } from "@/modules/access";
import { inboxImageFilesFromEnv, inboxImageResponse } from "@/modules/inbox";
import { getDatabase } from "@/modules/platform/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Картинка переписки «Входящих»: фото клиента (`in`) или картинка исходящего (`out`). Только для входа в кабинет — и в proxy, и здесь. */
export async function GET(_request: Request, context: { params: Promise<{ direction: string; id: string }> }) {
  try {
    await requireUser();
  } catch (error) {
    return accessErrorResponse(error) ?? Promise.reject(error);
  }
  const { direction, id } = await context.params;
  return inboxImageResponse(getDatabase().db, inboxImageFilesFromEnv(), direction, id);
}
