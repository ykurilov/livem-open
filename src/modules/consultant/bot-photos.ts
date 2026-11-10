import { eq } from "drizzle-orm";
import { bots } from "../channels/schema";
import { people } from "../people/schema";
import type { Database } from "../platform/db";
import { isUuid } from "../platform/uuid";

/** Строка хвоста: бот этого человека не может прислать картинку (у ключа ВКонтакте нет права «Фотографии»). */
export const NO_PHOTOS_LINE = "Картинки в этом мессенджере до человека не доходят: не показывай их через show_image и не ссылайся на картинку в ответе.";

/**
 * Бот, через которого говорит человек, картинок не присылает. Тестовый разговор эксперта, веб-чат и боты с правом — `false`:
 * строки в хвосте нет, запрос прежний.
 */
export async function botSendsNoPhotos(db: Database, ownerId: string): Promise<boolean> {
  if (!isUuid(ownerId)) return false;
  const [row] = await db
    .select({ canSendPhotos: bots.canSendPhotos })
    .from(people)
    .innerJoin(bots, eq(bots.id, people.botId))
    .where(eq(people.id, ownerId));
  return row?.canSendPhotos === false;
}
