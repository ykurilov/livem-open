import type { AgentSettings, StepContext } from "@ykurilov/agent-chat-core";
import { createImageLibrary, type ImageSource } from "@ykurilov/agent-chat-image-library";
import { createVideoLibrary, type VideoSource } from "@ykurilov/agent-chat-videos";
import type { PersonLinkTools } from "@ykurilov/agent-chat-web-tools";
import { logToolCalls } from "../agent-log/capture";
import type { LeadMagnetSettings } from "../lead-magnets";
import type { DatabaseExecutor } from "../platform/db";
import { getImages } from "../images";
import { getVideos } from "../videos";
import { AGENT_TIME_ZONE, PROVIDER_FALLBACK } from "../platform/models-catalog";
import { buildConsultantInstruction } from "./instruction";
import type { ConversationStore } from "./preview-store";
import { oneImagePerReply, oneVideoPerReply } from "./one-per-reply";
import { createConsultantTools } from "./tools";
import { appDomainsIn } from "./app-address";
import { leadMagnetKnownTexts } from "./known-texts";
import { viewsLinks } from "./instruction";

/** Общие на процесс: настройки пересоздаются каждый ход, а помнить показанный ролик и картинку надо весь ответ. */
const limitVideosPerReply = oneVideoPerReply();
const limitImagesPerReply = oneImagePerReply();

/**
 * Настройки агента консультанта для одной версии лидмагнита. Инструкция неизменна — начало запроса из кэша модели.
 * Сценарий SDK (`flow.withChat`) добавляет к ним свою инструкцию, служебные инструменты и строки хвоста.
 */
export function consultantAgentSettings(input: {
  settings: LeadMagnetSettings;
  store: ConversationStore;
  /** Ролики, разрешённые этой версии. Нет разрешённых — инструментов видео у консультанта нет вовсе. */
  videos: VideoSource;
  /** Картинки, разрешённые этой версии. Нет разрешённых — инструментов картинок у консультанта нет вовсе. */
  images: ImageSource;
  /** Просмотр ссылки человека; нужен, только если он включён в настройках. Нет ключа Firecrawl — `null`. */
  personLink?: PersonLinkTools | null;
  /** Наш хвост хода в конце запроса каждого шага, мимо истории (`consultantStepContext`); строки сценария — после него. */
  stepContext?: StepContext;
  /** День программы чата: в него записывается ответ на продажу. Нет — день 1. */
  dayOf?(chat: { ownerId: string; chatId: string }): Promise<number>;
}): AgentSettings {
  const personLink = viewsLinks(input.settings) ? (input.personLink ?? null) : null;
  const appDomains = appDomainsIn(leadMagnetKnownTexts(input.settings));
  const videoLibrary = input.settings.videoIds.length > 0 ? createVideoLibrary({ source: input.videos }) : null;
  const imageLibrary = input.settings.imageIds.length > 0 ? createImageLibrary({ source: input.images }) : null;
  return {
    instructions: buildConsultantInstruction(input.settings),
    tools: (model) =>
      logToolCalls(
        {
          ...createConsultantTools({
            store: input.store,
            chatId: model.chatId,
            settings: input.settings,
            saleDay: async () => (input.dayOf ? input.dayOf({ ownerId: model.ownerId, chatId: model.chatId }) : 1),
          }),
          ...(videoLibrary && limitVideosPerReply(videoLibrary.tools(model), model)),
          ...(imageLibrary && limitImagesPerReply(imageLibrary.tools(model), model)),
          ...(personLink && personLink(model, { appDomains })),
        },
        model.chatId,
      ),
    // Итог и ответ на продажу — по очереди, в порядке вызовов
    sequentialTools: true,
    ...(input.stepContext && { stepContext: input.stepContext }),
    timeZone: AGENT_TIME_ZONE,
    providerFallback: PROVIDER_FALLBACK,
  };
}

/**
 * Настройки только с живыми роликами и картинками: удалённые из архива выпадают, а без живых у консультанта нет ни
 * инструментов, ни правила о них. Опубликованная версия хранит лишь id, поэтому сверка с архивом — при каждом ходе.
 */
export async function withLiveMedia(db: DatabaseExecutor, settings: LeadMagnetSettings): Promise<LeadMagnetSettings> {
  const [liveVideos, liveImages] = await Promise.all([
    settings.videoIds.length === 0 ? [] : getVideos(db, settings.videoIds).then((videos) => videos.map((video) => video.id)),
    settings.imageIds.length === 0 ? [] : getImages(db, settings.imageIds).then((images) => images.map((image) => image.id)),
  ]);
  if (liveVideos.length === settings.videoIds.length && liveImages.length === settings.imageIds.length) return settings;
  return { ...settings, videoIds: liveVideos, imageIds: liveImages };
}

/** Ключ кэша версии: набор живых роликов и картинок меняет инструкцию и инструменты. */
export const liveVersionKey = (versionId: string, settings: LeadMagnetSettings) =>
  `${versionId}:${settings.videoIds.join(",")}:${settings.imageIds.join(",")}`;

/** Кэш по id версии (или снимка): у каждой версии своя неизменная инструкция и свой сервис. */
export class VersionCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly limit: number) {}

  async get(key: string, create: () => Promise<T>): Promise<T> {
    const found = this.entries.get(key);
    if (found !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, found);
      return found;
    }
    const created = await create();
    this.entries.set(key, created);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return created;
  }

  values(): T[] {
    return [...this.entries.values()];
  }
}
