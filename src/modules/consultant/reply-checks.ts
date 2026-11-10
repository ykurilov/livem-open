import type { KnownTexts, ReplyCheck } from "@ykurilov/agent-chat-core";
import { foreignWords, unknownLinks } from "@ykurilov/agent-chat-reply-check";
import type { LeadMagnetSettings } from "../lead-magnets";
import type { DatabaseExecutor } from "../platform/db";
import { getImages } from "../images";
import { getVideos } from "../videos";
import type { KnowledgeText } from "../knowledge";
import { appDomainsIn } from "./app-address";
import { leadMagnetKnownTexts } from "./known-texts";

/**
 * Наши тексты вне сценария, слова и ссылки из которых законны: первое сообщение и прощание (их шлёт приложение, а не
 * модель), тексты баз знаний (их дал эксперт), названия роликов и картинок. Тексты сценария — общую часть, ноды, рамку дня, попутные задачи — SDK добавляет сам
 * (`replyChecks` передаются через `flow.withChat`). Сбой загрузки архива не запоминается: следующая проверка грузит заново.
 */
export function leadMagnetOwnTexts(db: DatabaseExecutor, settings: LeadMagnetSettings, knowledge: readonly KnowledgeText[] = []): KnownTexts {
  const own = [settings.firstMessage, settings.farewellMessage, ...knowledge.map((base) => base.content)].filter((text) => text.trim().length > 0);
  let titles: Promise<string[]> | undefined;
  return async () => {
    if (settings.videoIds.length === 0 && settings.imageIds.length === 0) return own;
    titles ??= Promise.all([
      settings.videoIds.length > 0 ? getVideos(db, settings.videoIds) : [],
      settings.imageIds.length > 0 ? getImages(db, settings.imageIds) : [],
    ]).then(
      ([videos, images]) => [...videos, ...images].map((item) => item.title),
      (error: unknown) => {
        titles = undefined;
        throw error;
      },
    );
    return [...own, ...(await titles)];
  };
}

/**
 * Проверки ответа консультанта одной версии лидмагнита для `replyChecks` службы SDK: чужие слова (кириллица) и ссылки
 * не из настроек: короткая ссылка из `text_link` законна как результат инструмента. Адрес вида «имя.apps.example.com» законен, если домен описан в инструкции, а имя назвал человек. Те же
 * проверки идут и для текста вне хода (`service.checkReply`): ответ из `finish_dialog`.
 */
export function consultantReplyChecks(deps: {
  db: DatabaseExecutor;
  settings: LeadMagnetSettings;
  knowledge?: readonly KnowledgeText[];
}): { checks: ReplyCheck[]; knownTexts: KnownTexts } {
  const { db, settings } = deps;
  const appDomains = appDomainsIn(leadMagnetKnownTexts(settings));
  return {
    checks: [foreignWords({ script: "cyrillic" }), unknownLinks({ appDomains })],
    knownTexts: leadMagnetOwnTexts(db, settings, deps.knowledge),
  };
}
