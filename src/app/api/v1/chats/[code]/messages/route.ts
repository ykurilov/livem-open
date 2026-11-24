import { chatApiFor } from "@/modules/chat-api/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ code: string }> };

/** Публичный API: история и новые сообщения. Описание — `/docs/api`. */
export async function GET(request: Request, context: Context) {
  return (await chatApiFor(request)).messages(request, (await context.params).code);
}

/** Публичный API: сообщение посетителя. */
export async function POST(request: Request, context: Context) {
  return (await chatApiFor(request)).send(request, (await context.params).code);
}

export async function OPTIONS(request: Request) {
  return (await chatApiFor(request)).preflight(request);
}
