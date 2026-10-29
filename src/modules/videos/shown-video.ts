import { isVideoAddress, timeLabel, watchUrl } from "@ykurilov/agent-chat-videos";

/** Ролик, который консультант показал: для мессенджера, «Входящих», карточки человека и «Лога». */
export interface ShownVideoLink {
  title: string;
  /** Страница видео на площадке, с отметкой начала. */
  url: string;
  /** «3:20», если ролик показан не с начала. */
  startLabel?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Результат `show_video` → ролик со ссылкой; отказ или чужие данные — `null`. */
export function shownVideoOf(output: unknown): ShownVideoLink | null {
  if (!isRecord(output) || !isRecord(output["видео"])) return null;
  const video = output["видео"];
  const address = { provider: video["площадка"], code: video["код"] };
  if (typeof video["название"] !== "string" || !isVideoAddress(address)) return null;
  const start = typeof video["начало"] === "number" && video["начало"] > 0 ? video["начало"] : undefined;
  return {
    title: video["название"],
    url: watchUrl(address, start),
    ...(start !== undefined && { startLabel: timeLabel(start) }),
  };
}

/** Ролики, показанные в сообщении через `show_video`, по порядку; отказы и незаконченные вызовы пропускаются. */
export function shownVideosOf(parts: readonly unknown[]): Array<{ id: string; link: ShownVideoLink }> {
  return parts.flatMap((part) => {
    if (!isRecord(part) || part["type"] !== "tool-show_video" || part["state"] !== "output-available") return [];
    const link = shownVideoOf(part["output"]);
    const id = isRecord(part["output"]) && isRecord(part["output"]["видео"]) ? part["output"]["видео"]["id"] : undefined;
    return link && typeof id === "string" ? [{ id, link }] : [];
  });
}

/**
 * Какой ролик человек получил с каждым ответом разговора (части ответов по порядку): только первый показанный в ответе,
 * и то если его не показывали раньше. Сколько бы роликов ни показала модель, правило одно — для мессенджера и карточки.
 */
export function sentVideosOf(replies: ReadonlyArray<readonly unknown[]>): Array<ShownVideoLink | null> {
  const sent = new Set<string>();
  return replies.map((parts) => {
    const [first] = shownVideosOf(parts);
    if (!first || sent.has(first.id)) return null;
    sent.add(first.id);
    return first.link;
  });
}

/** Отдельное сообщение с роликом в мессенджере: превью по ссылке мессенджер строит сам. */
export function videoMessageText(video: ShownVideoLink): string {
  return [`▶ ${video.title}`, video.startLabel && `с ${video.startLabel}`, video.url].filter(Boolean).join("\n");
}
