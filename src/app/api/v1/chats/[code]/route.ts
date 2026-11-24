import { chatApiFor } from "@/modules/chat-api/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ code: string }> };

/** Публичный API: название чата, принимает ли фото, есть ли микрофон. Описание — `/docs/api`. */
export async function GET(request: Request, context: Context) {
  return (await chatApiFor(request)).chat(request, (await context.params).code);
}

export async function OPTIONS(request: Request) {
  return (await chatApiFor(request)).preflight(request);
}
