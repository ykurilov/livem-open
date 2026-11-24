import { chatApiFor } from "@/modules/chat-api/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ code: string }> };

/** Публичный API: начать или продолжить разговор. Описание — `/docs/api`. */
export async function POST(request: Request, context: Context) {
  return (await chatApiFor(request)).session(request, (await context.params).code);
}

export async function OPTIONS(request: Request) {
  return (await chatApiFor(request)).preflight(request);
}
