import { isUniqueViolation, type DatabaseExecutor } from "../platform/db";
import { isUuid } from "../platform/uuid";
import { removeMailingImage, saveMailingImage, uploadsDir } from "./images";
import { MailingError, createMailing, getMailing, updateMailingDraft, type Mailing } from "./mailings";

export interface MailingDraftInput {
  /** `null` — новая рассылка. */
  id: string | null;
  /** Id новой рассылки из формы: повтор той же отправки после потерянного ответа находит уже созданную, а не делает вторую. */
  requestId?: string;
  text: string;
  filter: unknown;
  testPersonId: string | null;
  /** Новая картинка из формы. */
  image: { name: string; bytes: Uint8Array } | null;
  /** Убрать прикреплённую картинку. */
  removeImage: boolean;
}

/**
 * Сохраняет черновик из формы вместе с картинкой и не оставляет файлов-сирот:
 * заменённая или убранная картинка удаляется, а новая — если черновик не сохранился.
 * Повтор уже запущенной новой рассылки отдаёт её как есть: запускать её второй раз нельзя.
 * Одновременный повтор, опоздавший к созданию, тоже получает уже созданную рассылку как есть.
 */
export async function saveMailingDraft(db: DatabaseExecutor, input: MailingDraftInput, dir = uploadsDir()): Promise<Mailing> {
  const repeated = !input.id && input.requestId ? await getMailing(db, input.requestId) : null;
  if (repeated && repeated.status !== "draft") return repeated;
  const existing = input.id ? await getMailing(db, input.id) : repeated;
  if (input.id && !existing) throw new MailingError("Рассылка не найдена");

  const newImage = input.image ? await saveMailingImage(input.image, dir) : null;
  const imagePath = newImage ?? (input.removeImage ? null : (existing?.imagePath ?? null));
  const draft = { text: input.text, imagePath, filter: input.filter, testPersonId: input.testPersonId };
  let saved: Mailing;
  try {
    saved = existing ? await updateMailingDraft(db, existing.id, draft) : await createMailing(db, draft, isUuid(input.requestId ?? "") ? input.requestId : undefined);
  } catch (error) {
    if (newImage) await removeMailingImage(newImage, dir);
    const created = !existing && isUniqueViolation(error) && input.requestId ? await getMailing(db, input.requestId) : null;
    if (created) return created;
    throw error;
  }
  if (existing?.imagePath && existing.imagePath !== saved.imagePath) await removeMailingImage(existing.imagePath, dir);
  return saved;
}
