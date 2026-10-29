import { createChannelAdapters } from "@/modules/channels";
import { acceptWebhook } from "@/modules/conversations";
import { createTokenCipher } from "@/modules/platform/crypto";
import { getDatabase } from "@/modules/platform/db";
import { requireEnv } from "@/modules/platform/env";
import { getWebQueue } from "@/modules/platform/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Вебхук мессенджера: записать входящее, поставить задачу и сразу ответить. Ни модели, ни мессенджера. */
export async function POST(request: Request, context: { params: Promise<{ channel: string; botId: string }> }) {
  const { channel, botId } = await context.params;
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
  const result = await acceptWebhook(
    {
      db: getDatabase().db,
      queue: await getWebQueue(),
      adapters: createChannelAdapters(),
      cipher: createTokenCipher(requireEnv("BOT_TOKEN_KEY")),
    },
    { channel, botId, request: { headers, body: await request.text() } },
  );
  return new Response(result.body, { status: result.status });
}
