import { GETCOURSE_SECRET_ENV, parseGetCourseNotice, sameSecret } from "./getcourse";
import { recordOrderNotice } from "./orders";
import { reactToOrder, type PurchaseDependencies } from "./reactions";

/** Больше уведомление о заказе не бывает: длиннее — 413, тело не читается дальше. */
export const MAX_NOTICE_BYTES = 64 * 1024;

export interface GetCourseWebhookResult {
  status: number;
  body: { ok: boolean; error?: string; matched?: boolean };
}

/** Тело уведомления: JSON или форма (процесс GetCourse умеет и то и другое). */
export function bodyOf(text: string, contentType: string | null): unknown {
  if (contentType?.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

/**
 * Уведомление GetCourse о заказе (`POST /api/integrations/getcourse/<секрет>`). Порядок: секрет (за постоянное время)
 * → размер → тело → база и очередь. Чужой секрет — 404 без чтения тела: адрес не выдаёт, что он есть. Дальше запись
 * заказа и реакция (покупка и поздравление, напоминание, возврат). Модель здесь не зовётся. Повтор безопасен.
 */
export async function acceptGetCourseWebhook(
  config: { expectedSecret: string | undefined; deps: () => Promise<PurchaseDependencies> },
  input: { secret: string; contentType: string | null; contentLength: string | null; readBody: () => Promise<string> },
): Promise<GetCourseWebhookResult> {
  if (!config.expectedSecret) console.error(`Уведомления GetCourse не принимаются: не задан ${GETCOURSE_SECRET_ENV}`);
  if (!sameSecret(input.secret, config.expectedSecret ?? "")) return { status: 404, body: { ok: false } };
  const tooLarge = { status: 413, body: { ok: false, error: "Слишком большое уведомление" } };
  if (Number(input.contentLength ?? 0) > MAX_NOTICE_BYTES) return tooLarge;
  const text = await input.readBody();
  if (Buffer.byteLength(text) > MAX_NOTICE_BYTES) return tooLarge;
  const body = bodyOf(text, input.contentType);
  const notice = parseGetCourseNotice(body);
  if (!notice) return { status: 400, body: { ok: false, error: "Нет id заказа" } };
  const deps = await config.deps();
  const recorded = await recordOrderNotice(deps, "getcourse", notice, body as Record<string, unknown>);
  await reactToOrder(deps, recorded);
  return { status: 200, body: { ok: true, matched: recorded.order.passageId !== null } };
}
