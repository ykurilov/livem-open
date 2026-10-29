import type { AttachmentKind } from "../channels";

export const ATTACHMENT_LABELS: Record<AttachmentKind, string> = {
  image: "картинка",
  voice: "голосовое сообщение",
  sticker: "стикер",
  file: "файл",
  other: "вложение",
};

export interface PersonMessage {
  text: string;
  attachmentKind: AttachmentKind | null;
}

/**
 * Текст сообщения человека для консультанта: обрезан до `maxChars`, вложение без подписи — метка «[картинка]».
 * Склеивает сообщения одного хода SDK (`sendBurstMessage`): в истории каждое отдельно.
 */
export function personMessageText(message: PersonMessage, maxChars: number): string {
  let text = message.text.trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  const label = message.attachmentKind ? ATTACHMENT_LABELS[message.attachmentKind] : null;
  return !text && label ? `[${label}]` : text;
}

/** Пометка о вложениях хода — для хвоста, в историю она не идёт; вложений нет — `null`. */
export function attachmentNoteOf(messages: readonly PersonMessage[]): string | null {
  const labels = [...new Set(messages.flatMap((message) => (message.attachmentKind ? [ATTACHMENT_LABELS[message.attachmentKind]] : [])))];
  return labels.length > 0
    ? `Человек прислал вложение (${labels.join(", ")}). Его содержимое тебе недоступно: ` +
        "продолжай разговор текстом, при необходимости попроси пересказать словами."
    : null;
}
