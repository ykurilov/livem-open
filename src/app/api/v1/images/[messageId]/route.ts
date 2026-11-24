import { chatApiFor } from "@/modules/chat-api/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Картинка из истории по подписанной ссылке: `<img>` на чужом сайте заголовок с токеном не пошлёт. */
export async function GET(request: Request, context: { params: Promise<{ messageId: string }> }) {
  return (await chatApiFor(request)).image(request, (await context.params).messageId);
}
