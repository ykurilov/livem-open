import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { optionalEnv } from "@/modules/platform/env";
import { getWebQueue } from "@/modules/platform/queue";
import { acceptGetCourseWebhook, MAX_NOTICE_BYTES } from "@/modules/purchases/webhook";
import { GETCOURSE_SECRET_ENV } from "@/modules/purchases/getcourse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Уведомление процесса GetCourse о заказе: записать и сразу ответить. Поздравляет и напоминает работник. */
export async function POST(request: Request, context: { params: Promise<{ secret: string }> }) {
  const { secret } = await context.params;
  const result = await acceptGetCourseWebhook(
    // База и очередь — только после проверки секрета
    { expectedSecret: optionalEnv(GETCOURSE_SECRET_ENV), deps: async () => ({ db: getDatabase().db, queue: await getWebQueue(), clock: systemClock }) },
    {
      secret,
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
      readBody: () => readAtMost(request, MAX_NOTICE_BYTES + 1),
    },
  );
  return Response.json(result.body, { status: result.status });
}

/** Тело не длиннее `limit` байт: дальше не читаем — этого хватает, чтобы ответить 413. */
async function readAtMost(request: Request, limit: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    chunks.push(chunk.value);
    size += chunk.value.byteLength;
    if (size >= limit) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
