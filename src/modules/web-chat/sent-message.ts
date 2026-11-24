import { randomUUID } from "node:crypto";
import { IMAGE_MAX_BYTES } from "../images/image-limits";

/** С запасом на поля формы поверх самого фото. */
const SENT_FORM_MAX_BYTES = IMAGE_MAX_BYTES + 64 * 1024;
const PHOTO_TOO_BIG = "Фото больше 10 МБ: пришлите поменьше";

export type SentMessage =
  | { ok: true; text: string; clientId: string; code?: string; photo?: Uint8Array }
  | { ok: false; status: number; error: string };

/**
 * Сообщение посетителя из тела запроса: JSON `{text, clientId?, code?}` или форма с теми же полями и фото `photo`.
 * Без `clientId` — новый: повтор такого запроса даст второе сообщение.
 */
export async function readSentMessage(request: Request): Promise<SentMessage> {
  const field = (value: unknown) => (typeof value === "string" ? value : undefined);
  const rest = (clientId: unknown, code: unknown) => ({ clientId: field(clientId) || randomUUID(), ...(field(code) && { code: field(code) }) });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    const body = (await request.json().catch(() => null)) as { text?: unknown; clientId?: unknown; code?: unknown } | null;
    const text = field(body?.text);
    return text === undefined ? { ok: false, status: 400, error: "Напишите сообщение" } : { ok: true, text, ...rest(body?.clientId, body?.code) };
  }
  if (Number(request.headers.get("content-length") ?? 0) > SENT_FORM_MAX_BYTES) return { ok: false, status: 413, error: PHOTO_TOO_BIG };
  const form = await request.formData().catch(() => null);
  if (!form) return { ok: false, status: 400, error: "Не удалось прочитать сообщение" };
  const file = form.get("photo");
  const photo = file instanceof Blob && file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : undefined;
  if (photo && photo.byteLength > IMAGE_MAX_BYTES) return { ok: false, status: 413, error: PHOTO_TOO_BIG };
  return { ok: true, text: field(form.get("text")) ?? "", photo, ...rest(form.get("clientId"), form.get("code")) };
}
