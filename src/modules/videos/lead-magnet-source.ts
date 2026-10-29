import { searchVideos, type VideoEntry, type VideoSource } from "@ykurilov/agent-chat-videos";
import type { DatabaseExecutor } from "../platform/db";
import { getVideos, type Video } from "./archive";

function entryOf(video: Video): VideoEntry {
  return {
    id: video.id,
    title: video.title,
    url: video.url,
    description: video.description,
    ...(video.durationSeconds !== null && { durationSeconds: video.durationSeconds }),
    ...(video.chapters.length > 0 && { chapters: video.chapters }),
  };
}

/**
 * Каталог видео для консультанта одной версии лидмагнита: только ролики, которые эксперт разрешил в этой версии.
 * Архив у кабинета один, поэтому владелец разговора на выбор не влияет — границу задаёт список `allowedIds`.
 */
export function leadMagnetVideoSource(db: DatabaseExecutor, allowedIds: readonly string[]): VideoSource {
  return {
    async search(query) {
      return searchVideos((await getVideos(db, allowedIds)).map(entryOf), query);
    },
    async get(id) {
      if (!allowedIds.includes(id)) return undefined;
      const [video] = await getVideos(db, [id]);
      return video && entryOf(video);
    },
  };
}
