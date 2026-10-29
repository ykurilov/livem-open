import { accessErrorResponse, requireUser } from "@/modules/access";
import { imageResponse } from "@/modules/images";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Картинка архива эксперта: для кабинета и проверки консультанта. Только для входа в кабинет — и в proxy, и здесь. */
export async function GET(_request: Request, context: { params: Promise<{ name: string }> }) {
  try {
    await requireUser();
  } catch (error) {
    return accessErrorResponse(error) ?? Promise.reject(error);
  }
  return imageResponse((await context.params).name);
}
