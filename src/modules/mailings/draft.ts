import type { DatabaseExecutor } from "../platform/db";
import { removeMailingImage, saveMailingImage, uploadsDir } from "./images";
import { MailingError, createMailing, getMailing, updateMailingDraft, type Mailing } from "./mailings";

export interface MailingDraftInput {
  /** `null` — новая рассылка. */
  id: string | null;
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
 */
export async function saveMailingDraft(db: DatabaseExecutor, input: MailingDraftInput, dir = uploadsDir()): Promise<Mailing> {
  const existing = input.id ? await getMailing(db, input.id) : null;
  if (input.id && !existing) throw new MailingError("Рассылка не найдена");

  const newImage = input.image ? await saveMailingImage(input.image, dir) : null;
  const imagePath = newImage ?? (input.removeImage ? null : (existing?.imagePath ?? null));
  const draft = { text: input.text, imagePath, filter: input.filter, testPersonId: input.testPersonId };
  let saved: Mailing;
  try {
    saved = existing ? await updateMailingDraft(db, existing.id, draft) : await createMailing(db, draft);
  } catch (error) {
    if (newImage) await removeMailingImage(newImage, dir);
    throw error;
  }
  if (existing?.imagePath && existing.imagePath !== saved.imagePath) await removeMailingImage(existing.imagePath, dir);
  return saved;
}
