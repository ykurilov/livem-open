import { searchImages, type ImageEntry, type ImageSource } from "@ykurilov/agent-chat-image-library";
import type { DatabaseExecutor } from "../platform/db";
import { getImages, type ExpertImage } from "./archive";
import { imageUrl } from "./image-file";

function entryOf(image: ExpertImage): ImageEntry {
  return {
    id: image.id,
    title: image.title,
    // Описание эксперта говорит, что на картинке и когда она нужна: его же прочтёт экранный диктор
    alt: image.description,
    description: image.description,
    url: imageUrl(image.fileName),
    width: image.width,
    height: image.height,
  };
}

/**
 * Каталог картинок для консультанта одной версии лидмагнита: только картинки, которые эксперт разрешил в этой версии.
 * Архив у кабинета один, поэтому владелец разговора на выбор не влияет — границу задаёт список `allowedIds`.
 */
export function leadMagnetImageSource(db: DatabaseExecutor, allowedIds: readonly string[]): ImageSource {
  return {
    async search(query) {
      return searchImages((await getImages(db, allowedIds)).map(entryOf), query);
    },
    async get(id) {
      if (!allowedIds.includes(id)) return undefined;
      const [image] = await getImages(db, [id]);
      return image && entryOf(image);
    },
  };
}
